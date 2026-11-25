/**
 * Nexora Proxy 3.6.1 — Cloudflare Workers（Service Worker 方式 / JSProxy 型）
 *
 * ・/_nx/home            ブラウザシェル（Persistent Browser Shell: タブ = iframe。トップレベルは遷移しない）
 * ・/_nx/start           シェル内タブのホーム（landing）   /_nx/landing: 単体表示のランディング（フォールバック）
 * ・/_nx/sw.js           Service Worker（全リクエストを横取りして /_nx/r へ流す）
 * ・/_nx/helper.js       ページ側ヘルパー（location 仮想化 / DOM・ストレージ・WebSocket フック）
 * ・/_nx/r?u=<b64url>    上流への中継（SW 専用。リダイレクト・Set-Cookie は SW が処理できる形に変換）
 * ・/_nx/ws?u=...        WebSocket 中継
 * ・/-----<URL>          プロキシ対象ページ（SW 未登録のときだけここに届き、登録→リロードする）
 *
 * ページの URL は https://<このWorker>/-----https://対象サイト/パス の形になります。
 * ページ内の相対 URL / サブリソースは <base> と SW によって本来の URL で処理されます。
 */

import { DurableObject } from "cloudflare:workers";

/* ============================== 設定 ============================== */

const NEXORA_VERSION = "3.6.2";
const NX_CACHE_NAME = "nexora-static-v3.6.2";

// URL の難読化に使うキー。好きな文字列に変えてよい（変えると、保存済みのブックマークや履歴のURLは開けなくなる）
// ※これは「見た目を読めなくする」ための難読化で、暗号ではない。クライアントに配る JS にも含まれる
const NX_KEY = "nexora-change-this-key";

const ROUTE = "/_nx";
const P_HOME = ROUTE + "/home";
const P_SW = ROUTE + "/sw.js";
const P_HELPER = ROUTE + "/helper.js";
const P_RELAY = ROUTE + "/r";
const P_WS = ROUTE + "/ws";
const P_START = ROUTE + "/start";       // シェル内タブのホーム（landing）
const P_LANDING = ROUTE + "/landing";   // 単体で開くランディング（フォールバック）
const PAGE_PREFIX = "/-----";
const RW_PREFIX = "/~/";
const P_RWJS = ROUTE + "/rw.js";

// コミュニティ(共有チャット)。チャット本体を置く Worker(ハブ)のオリジン。末尾にスラッシュは付けない。
const COMMUNITY_HUB = "https://nexora.wakame.workers.dev";
const P_COMMUNITY = ROUTE + "/community";
const P_CHAT_WS = ROUTE + "/chat";
const P_POST = ROUTE + "/post";
const P_MEDIA = ROUTE + "/media";

const CHAT_MAX_HISTORY = 200;               // チャット履歴の保存件数
const CHAT_MAX_TEXT = 500;                  // チャット1件の最大文字数
const CHAT_MAX_NAME = 20;                   // 名前の最大文字数
const CHAT_RATE_COUNT = 5;                  // CHAT_RATE_WINDOW_MS の間に送れるチャット数
const CHAT_RATE_WINDOW_MS = 10000;
const CHAT_MAX_POSTS = 100;                 // 投稿の保存件数(超えた古いものはファイルごと消える)
const CHAT_POST_TEXT = 500;                 // 投稿の本文の最大文字数
const CHAT_POST_INTERVAL_MS = 5000;         // 投稿の最短間隔
const CHAT_NAME_TTL_MS = 60 * 24 * 3600 * 1000; // 60日ログインが無い名前は、他の人が使えるようになる
const CHAT_FAIL_MAX = 8;                    // 合言葉の失敗の上限(CHAT_FAIL_WINDOW_MS の間)
const CHAT_FAIL_WINDOW_MS = 10 * 60 * 1000;
const MB = 1024 * 1024;
const CHAT_CHUNK = 1024 * 1024;           // ファイルを分けて保存する単位(SQLite の1行は2MiBまでなので1MiB)
const CHAT_MEDIA_TYPES = {
  "image/jpeg": { kind: "image", ext: ".jpg", max: 5 * MB },
  "image/png": { kind: "image", ext: ".png", max: 5 * MB },
  "image/gif": { kind: "image", ext: ".gif", max: 5 * MB },
  "image/webp": { kind: "image", ext: ".webp", max: 5 * MB },
  "audio/mpeg": { kind: "audio", ext: ".mp3", max: 15 * MB },
  "audio/mp4": { kind: "audio", ext: ".m4a", max: 15 * MB },
  "audio/x-m4a": { kind: "audio", ext: ".m4a", max: 15 * MB },
  "audio/aac": { kind: "audio", ext: ".aac", max: 15 * MB },
  "audio/ogg": { kind: "audio", ext: ".ogg", max: 15 * MB },
  "audio/wav": { kind: "audio", ext: ".wav", max: 15 * MB },
  "audio/x-wav": { kind: "audio", ext: ".wav", max: 15 * MB },
  "audio/webm": { kind: "audio", ext: ".weba", max: 15 * MB },
  "video/mp4": { kind: "video", ext: ".mp4", max: 30 * MB },
  "video/webm": { kind: "video", ext: ".webm", max: 30 * MB },
  "video/quicktime": { kind: "video", ext: ".mov", max: 30 * MB },
};
// 書き換えモードを既定にするサイト(シェルのメニューでサイトごとに変更できる)
const RW_DEFAULT_HOSTS = ["youtube.com", "youtu.be", "youtube-nocookie.com"];
// 書き換えモードで上流の応答から落とすヘッダ(content-length / content-encoding は残す)
const RW_UNSAFE_RESPONSE =
  /^(content-security-policy(-report-only)?|x-content-security-policy|x-frame-options|cross-origin-embedder-policy|cross-origin-opener-policy|cross-origin-resource-policy|referrer-policy|strict-transport-security|clear-site-data|link|report-to|reporting-endpoints|nel|alt-svc|expect-ct|public-key-pins.*|set-cookie2?|permissions-policy|origin-agent-cluster)$/i;

const SEARCH_BASE = "https://search.yahoo.co.jp/search?p=";
const HEADERS_TIMEOUT_MS = 25000; // 応答ヘッダ待ちの上限（本文ストリームは止めない）
const ENABLE_ERUDA = true;        // ナビバーの Eruda ボタン（スマホ用コンソール）
const ENABLE_TRANSITION = true;   // ページ遷移時のローディング演出
// Nexora 3.0: 常駐ブラウザシェル。タブごとに iframe を持ち、ページ移動でも Safari のトップレベルは遷移しない。
// false にすると 2.5 系と同じ「トップレベル遷移」方式に戻る（/_nx/home が landing、SW のリダイレクトも無効）。
const ENABLE_SHELL = true;

// ゲームポータル互換モード。ポータル型ゲームサイトでは、埋め込まれたゲーム本体の iframe を
// Nexora 側で書き換えず、そのまま（プロキシを経由しない別オリジンとして）動かした方が
// 互換性が高いことが多い。親ページ（ポータル部分）だけ Nexora で動かす。
const GAME_COMPAT_HOSTS = [
  "poki.com", "poki-cdn.com", "crazygames.com",
  "y8.com", "gameflare.com", "kbhgames.com", "coolmathgames.com",
  "miniplay.com", "itch.io", "newgrounds.com", "kongregate.com",
];

// WebSocket の任意ノード分散。未設定なら従来どおりこのWorkerが直接上流へ接続する。
// env.NEXORA_WS_NODES に JSON 配列を設定: [{"origin":"https://ws.example.com","weight":2}]
const WS_NODE_ENV = "NEXORA_WS_NODES";

// テスト用: env.NEXORA_ALLOW_PRIVATE があるとき、ローカル宛ても許可する（本番では未設定のこと）
let ALLOW_PRIVATE = false;

// 上流へ渡さないリクエストヘッダ（Cookie / Referer / Origin は x-nx-* から作り直す）
const BLOCK_REQUEST_HEADERS =
  /^(host|cookie|origin|referer|connection|keep-alive|te|trailer|content-length|transfer-encoding|accept-encoding|upgrade|upgrade-insecure-requests|if-none-match|if-modified-since|via|forwarded|x-forwarded-.*|x-real-ip|true-client-ip|cf-.*|cdn-loop|sec-fetch-.*|sec-websocket-.*|proxy-.*|x-nx-.*)$/i;

// 上流から受け取っても SW に渡さないレスポンスヘッダ
const DROP_RESPONSE_HEADERS =
  /^(content-security-policy(-report-only)?|x-content-security-policy|x-frame-options|cross-origin-resource-policy|report-to|reporting-endpoints|clear-site-data|alt-svc|expect-ct|link|set-cookie2?|content-length|content-encoding|transfer-encoding|connection|keep-alive|etag|last-modified|access-control-.*|strict-transport-security|public-key-pins.*|nel|permissions-policy|feature-policy|document-policy|origin-agent-cluster)$/i;

const BODY_LESS_STATUS = new Set([101, 204, 205, 304]);

/* ============================== 埋め込みソース（build.mjs が差し込む） ============================== */

const CODEC_SRC = String.raw`/* ---- codec: URL の難読化（Worker / SW / ページ側 / ホームで共有。NX_KEY が必要） ---- */
var NX_PREFIX="/-----";
function nxBytesToB64(b){
  var t="";
  for(var i=0;i<b.length;i++)t+=String.fromCharCode(b[i]);
  return btoa(t).split("+").join("-").split("/").join("_").replace(/=+$/,"");
}
function nxB64ToBytes(s){
  var v=String(s).split("-").join("+").split("_").join("/");
  while(v.length%4)v+="=";
  var bin=atob(v),a=new Uint8Array(bin.length);
  for(var i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);
  return a;
}
function nxHash(s){
  var h=2166136261;
  for(var i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)>>>0;}
  return h>>>0;
}
function nxKeyStream(salt){
  var x=(nxHash(NX_KEY)^Math.imul(salt,0x9E3779B1))>>>0;
  if(!x)x=0x1234567;
  return function(){
    x=(x^(x<<13))>>>0;
    x=(x^(x>>>17))>>>0;
    x=(x^(x<<5))>>>0;
    return x&255;
  };
}
/* 同じ文字列は必ず同じ結果（ソルトは内容から決める）。#hash だけのリンクが「同一ページ内の移動」のまま保たれる */
function nxEncUrl(s){
  s=String(s);
  var data=new TextEncoder().encode(s);
  var salt=(nxHash(s)%255)+1;
  var ks=nxKeyStream(salt);
  var out=new Uint8Array(data.length+2),sum=0;
  out[0]=salt;
  for(var i=0;i<data.length;i++){sum=(sum+data[i])&255;out[i+2]=data[i]^ks();}
  out[1]=(sum^salt^0x5a)&255;
  return nxBytesToB64(out);
}
function nxDecUrl(t){
  try{
    var b=nxB64ToBytes(t);
    if(b.length<2||!b[0])return null;
    var salt=b[0],ks=nxKeyStream(salt),plain=new Uint8Array(b.length-2),sum=0;
    for(var i=0;i<plain.length;i++){plain[i]=b[i+2]^ks();sum=(sum+plain[i])&255;}
    if(((sum^salt^0x5a)&255)!==b[1])return null;
    return new TextDecoder().decode(plain);
  }catch(e){return null;}
}
/* 実 URL → プロキシ上の URL。origin が "" なら相対パスを返す。#hash だけは暗号化せずそのまま付ける */
function nxWrapUrl(origin,real){
  real=String(real);
  var hash="",hi=real.indexOf("#");
  if(hi>=0){hash=real.slice(hi);real=real.slice(0,hi);}
  return origin+NX_PREFIX+nxEncUrl(real)+hash;
}
/*
 * プロキシ URL の「接頭辞より後ろ」→ 実 URL（失敗したら ""）。
 * フォームの GET 送信などでブラウザが付けた生のクエリは、暗号化済みの URL の検索部分を置き換える。
 * 旧形式（/-----https://...）も読める。
 */
function nxUnwrapRest(rest){
  rest=String(rest);
  var hash="",hi=rest.indexOf("#");
  if(hi>=0){hash=rest.slice(hi);rest=rest.slice(0,hi);}
  var q="",enc=rest,qi=rest.indexOf("?");
  if(qi>=0){q=rest.slice(qi);enc=rest.slice(0,qi);}
  if(/^https?:\/\//i.test(enc))return enc+q+hash;
  var real=nxDecUrl(enc);
  if(real===null)return "";
  if(q.length>1){
    var ri=real.indexOf("?");
    if(ri>=0)real=real.slice(0,ri);
    real+=q;
  }
  return real+hash;
}
/* 書き換えモードのURL: オリジンだけ暗号化し、パスは平文のまま */
function nxRwWrap(origin,real){
  try{
    var u=new URL(String(real));
    if(u.protocol!=="http:"&&u.protocol!=="https:")return "";
    return origin+"/~/"+nxEncUrl(u.origin)+u.pathname+u.search+u.hash;
  }catch(e){return "";}
}
/* "/~/" より後ろ → 実URL(失敗したら "") */
function nxRwUnwrapRest(rest){
  rest=String(rest);
  var m=/^([A-Za-z0-9_-]+)([\s\S]*)$/.exec(rest);
  if(!m)return "";
  var o=nxDecUrl(m[1]);
  if(!o||!/^https?:\/\/[^\/]+$/i.test(o))return "";
  var tail=m[2];
  if(!tail||tail.charAt(0)==="?"||tail.charAt(0)==="#")tail="/"+tail;
  return o+tail;
}
`;
const COMMON_SRC = String.raw`/* ---- common: SW と ページ側(helper)で共有 ---- */
function nxIsGameHost(host){
  host=String(host||"").toLowerCase().replace(/\.$/,"");
  var list=(typeof NX_GAME_HOSTS!=="undefined"&&NX_GAME_HOSTS)||[];
  for(var i=0;i<list.length;i++){
    var d=String(list[i]).toLowerCase();
    if(host===d||host.endsWith("."+d))return true;
  }
  return false;
}
/*
 * JS 内の識別子 location を __location に書き換える。
 * 文字列 / テンプレート / コメント / 正規表現リテラルの中は触らない。
 * オブジェクトのキー（{location: 1}）も触らない。
 * 書き換えが無ければ null を返す。
 */
var NX_REGEX_AFTER_WORD={"return":1,"typeof":1,"instanceof":1,"in":1,"of":1,"new":1,"delete":1,"void":1,"throw":1,"case":1,"do":1,"else":1,"yield":1,"await":1};
function nxRewriteJs(s){
  if(s.indexOf("location")<0&&s.indexOf("postMessage")<0)return null;
  var n=s.length,i=0,seg=0,out=[],hit=false;
  var pt="",pk="";            // 直前の意味のあるトークン（種別 / 値）
  var stack=[];               // "b"=通常の波括弧 , "t"=テンプレート式の波括弧
  function isIdc(c){return (c>=48&&c<=57)||(c>=65&&c<=90)||(c>=97&&c<=122)||c===95||c===36||c>127;}
  function scanTemplate(){    // テンプレート文字列の続きを読む（開始直後、または式の閉じ括弧の直後から）
    while(i<n){
      var c=s.charCodeAt(i);
      if(c===92){i+=2;continue;}
      if(c===96){i++;pt="tmpl";pk="";return;}
      if(c===36&&s.charCodeAt(i+1)===123){i+=2;stack.push("t");pt="punct";pk="{";return;}
      i++;
    }
  }
  while(i<n){
    var c=s.charCodeAt(i);
    if(c<=32||c===160||c===0x2028||c===0x2029||c===0xfeff){i++;continue;}
    if(c===47){                                   // /
      var d=s.charCodeAt(i+1);
      if(d===47){while(i<n&&s.charCodeAt(i)!==10)i++;continue;}
      if(d===42){var e=s.indexOf("*/",i+2);i=e<0?n:e+2;continue;}
      var re=(pt==="")||(pt==="punct"&&pk!==")"&&pk!=="]")||(pt==="id"&&NX_REGEX_AFTER_WORD[pk]===1);
      if(re){
        i++;var cls=false;
        while(i<n){
          var r=s.charCodeAt(i);
          if(r===92){i+=2;continue;}
          if(r===10)break;
          if(cls){if(r===93)cls=false;}
          else if(r===91)cls=true;
          else if(r===47){i++;break;}
          i++;
        }
        while(i<n&&isIdc(s.charCodeAt(i)))i++;
        pt="regex";pk="";continue;
      }
      i++;pt="punct";pk="/";continue;
    }
    if(c===34||c===39){                           // 文字列
      i++;
      while(i<n){
        var q=s.charCodeAt(i);
        if(q===92){i+=2;continue;}
        if(q===c){i++;break;}
        if(q===10)break;
        i++;
      }
      pt="str";pk="";continue;
    }
    if(c===96){i++;scanTemplate();continue;}      // テンプレート開始
    if(c===123){stack.push("b");i++;pt="punct";pk="{";continue;}
    if(c===125){                                  // }
      var top=stack.pop();i++;
      if(top==="t"){scanTemplate();continue;}
      pt="punct";pk="}";continue;
    }
    if(c>=48&&c<=57){
      i++;
      while(i<n){var m=s.charCodeAt(i);if(isIdc(m)||m===46)i++;else break;}
      pt="num";pk="";continue;
    }
    if(isIdc(c)){
      var st=i;i++;
      while(i<n&&isIdc(s.charCodeAt(i)))i++;
      var w=s.slice(st,i);
      if(w==="location"){
        var j=i;while(j<n&&s.charCodeAt(j)<=32)j++;
        var key=(s.charCodeAt(j)===58)&&pt==="punct"&&(pk==="{"||pk===",")&&stack[stack.length-1]==="b";
        if(!key){out.push(s.slice(seg,st),"__location");seg=i;hit=true;}
      }
      if(w==="postMessage"&&pt==="punct"&&pk==="."){
        var q=i;while(q<n&&s.charCodeAt(q)<=32)q++;
        if(s.charCodeAt(q)===40){
          out.push(s.slice(seg,st),"postMessage(...(self.__nx_sw?self.__nx_sw():[]),");
          seg=q+1;i=q+1;hit=true;pt="punct";pk="(";continue;
        }
      }
      pt="id";pk=w;continue;
    }
    pt="punct";pk=String.fromCharCode(c);i++;
  }
  if(!hit)return null;
  out.push(s.slice(seg));
  return out.join("");
}

/* ---- クッキー（SW のジャーとページ側のコピーで共有） ---- */
function nxIsExpired(c,now){var e=c.expires;return e!==null&&e!==undefined&&!isNaN(e)&&e<=now;}
function nxDefaultPath(p){
  p=String(p||"");
  if(!p||p.charAt(0)!=="/")return "/";
  var i=p.lastIndexOf("/");
  if(i<=0)return "/";
  return p.slice(0,i);
}
function nxPublicSuffixLike(d){
  return d.indexOf(".")<0||/^(co|com|ne|or|ac|go|gr|ed|ad|lg|org|net|gov|edu|gob|mil|nom|sch)\.[a-z]{2}$/.test(d);
}
function nxParseSetCookie(str,u,now){
  var parts=String(str).split(";");
  var first=parts.shift();
  var eq=first.indexOf("=");
  var c={id:"",name:eq<0?"":first.slice(0,eq).trim(),value:eq<0?first.trim():first.slice(eq+1).trim(),
    domain:"",hostOnly:false,path:"",expires:NaN,secure:false,httpOnly:false,sameSite:""};
  if(eq<0&&!c.value)return null;
  var maxAge=NaN;
  for(var i=0;i<parts.length;i++){
    var t=parts[i].trim();
    if(!t)continue;
    var j=t.indexOf("=");
    var k=(j<0?t:t.slice(0,j)).trim().toLowerCase();
    var v=j<0?"":t.slice(j+1).trim();
    if(k==="expires"){if(isNaN(c.expires))c.expires=Date.parse(v);}
    else if(k==="max-age")maxAge=parseInt(v,10);
    else if(k==="domain")c.domain=v.replace(/^\./,"").toLowerCase();
    else if(k==="path")c.path=v;
    else if(k==="secure")c.secure=true;
    else if(k==="httponly")c.httpOnly=true;
    else if(k==="samesite")c.sameSite=v;
  }
  if(!isNaN(maxAge))c.expires=maxAge<=0?0:now+maxAge*1000;
  var https=u.protocol==="https:";
  if(c.name.indexOf("__Secure-")===0&&(!https||!c.secure))return null;
  if(c.name.indexOf("__Host-")===0&&(!https||!c.secure||c.domain||(c.path&&c.path!=="/")))return null;
  if(c.secure&&!https)return null;
  var host=u.hostname.toLowerCase();
  if(c.domain){
    if(host!==c.domain&&host.slice(-(c.domain.length+1))!=="."+c.domain)return null;
    if(nxPublicSuffixLike(c.domain)&&host!==c.domain)return null;
  }else{
    c.domain=host;
    c.hostOnly=true;
  }
  c.path=c.path&&c.path.charAt(0)==="/"?c.path:nxDefaultPath(u.pathname);
  c.id=c.name+";"+c.domain+";"+c.path;
  return c;
}
function nxPut(map,c){
  if(nxIsExpired(c,Date.now()))map.delete(c.id);
  else map.set(c.id,c);
}
function nxHostMatch(c,host){
  return c.hostOnly?host===c.domain:(host===c.domain||host.slice(-(c.domain.length+1))==="."+c.domain);
}
function nxPathMatch(cp,p){
  if(p===cp)return true;
  if(p.indexOf(cp)!==0)return false;
  return cp.charAt(cp.length-1)==="/"||p.charAt(cp.length)==="/";
}
function nxCookieString(map,urlStr,includeHttpOnly){
  var u;
  try{u=new URL(urlStr);}catch(e){return "";}
  var now=Date.now(),https=u.protocol==="https:",host=u.hostname.toLowerCase(),list=[];
  map.forEach(function(c){
    if(nxIsExpired(c,now)){map.delete(c.id);return;}
    if(c.secure&&!https)return;
    if(c.httpOnly&&!includeHttpOnly)return;
    if(!nxHostMatch(c,host))return;
    if(!nxPathMatch(c.path,u.pathname))return;
    list.push(c);
  });
  list.sort(function(a,b){return b.path.length-a.path.length;});
  return list.map(function(c){return c.name?c.name+"="+c.value:c.value;}).join("; ");
}
function nxCookiesForHost(map,host){
  var now=Date.now(),out=[];
  map.forEach(function(c){if(!nxIsExpired(c,now)&&nxHostMatch(c,host))out.push(c);});
  return out;
}
`;
const SW_SRC = String.raw`/* ============================== Nexora Service Worker ============================== */

var PREFIX = "/-----";
var ORIGIN = self.location.origin;
var RELAY = ORIGIN + "/_nx/r?u=";
var HELPER_URL = ORIGIN + "/_nx/helper.js?v=" + NX_VER;
var MAX_REDIRECTS = 20;
var RELAY_TIMEOUT_MS = 30000; // ブラウザ→Worker の中継リクエストがハングし続けないようにする保険
var ENC = new TextEncoder();
var DEC = new TextDecoder();
var NX_STATIC_CACHE = "nexora-static-" + NX_VER;
function nxIsNextAsset(url) { try { var u = new URL(url); return /\/_next\/(?:static\/|)/i.test(u.pathname); } catch (e) { return false; } }
/*
 * Next.js のコアランタイムは、Nexora の location/postMessage 識別子変換を
 * 受けると HeadManager 等の内部処理が壊れる可能性があるため、そのまま通す。
 * ページ固有コード（pages/_app や pages/index 等）は従来どおり書き換える。
 */
function nxIsNextRuntimeScript(url) {
  try {
    var p = new URL(url).pathname;
    return /\/_next\/static\/chunks\/(?:framework|main|webpack|polyfills)-[^/]+\.js$/i.test(p);
  } catch (e) { return false; }
}
function nxLooksLikeHtml(bytes) { try { var n = Math.min(bytes.length, 512); var t = DEC.decode(bytes.slice(0, n)).replace(/^\uFEFF/, "").trimStart().toLowerCase(); return t.indexOf("<!doctype html") === 0 || t.indexOf("<html") === 0 || t.indexOf("<head") === 0 || t.indexOf("<body") === 0; } catch (e) { return false; } }
function nxAssetFailureResponse(status, kind, url) {
  var ct = kind === "css" ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8";
  var body = kind === "css" ? "/* Nexora asset compatibility: upstream returned an HTML/error document. */" : "/* Nexora asset compatibility: upstream returned an HTML/error document. */";
  return new Response(body, { status: status || 404, headers: { "content-type": ct, "cache-control": "no-store", "x-nx-asset-error": "1", "x-nx-asset-url": nxDebugSafeUrl(url) } });
}
var nxDebugLogs = [];
var nxDebugCacheHits = 0;
function nxDebugRecord(method, url, status, ms, cache, meta) {
  meta = meta || {};
  nxDebugLogs.push({
    method: method || "GET",
    url: String(url || ""),
    status: Number(status || 0),
    ms: Math.max(0, Math.round(ms || 0)),
    serverMs: Math.max(0, Math.round(meta.serverMs || 0)),
    source: String(meta.source || (cache ? "cache" : "unknown")),
    detail: String(meta.detail || ""),
    cache: !!cache
  });
  if (nxDebugLogs.length > 80) nxDebugLogs.splice(0, nxDebugLogs.length - 80);
}
function nxDebugSafeUrl(url) { try { var u = new URL(url); return u.origin + u.pathname + u.search; } catch (e) { return String(url || ""); } }

/* ブラウザ→Worker 間の中継 fetch 専用タイムアウト。上流（対象サイト）側のタイムアウトは
 * Worker 側の fetchWithTimeout が別途担当している。ここで固まると respondWith が解決されず
 * ブラウザが「このページを読み込めませんでした」を出すので、必ずどこかで決着させる。 */
function fetchRelay(url, init) {
  return new Promise(function (resolve) {
    var done = false;
    var timer = setTimeout(function () {
      if (done) return;
      done = true;
      resolve({ __nxTimeout: true });
    }, RELAY_TIMEOUT_MS);
    fetch(url, init).then(
      function (res) { if (done) return; done = true; clearTimeout(timer); resolve(res); },
      function (err) { if (done) return; done = true; clearTimeout(timer); resolve({ __nxError: err }); }
    );
  });
}

self.addEventListener("install", function (e) { e.waitUntil(self.skipWaiting()); });
self.addEventListener("activate", function (e) {
  e.waitUntil((async function () {
    try {
      var ks = await caches.keys();
      await Promise.all(ks.filter(function (k) { return k.indexOf("nexora-static-") === 0 && k !== NX_STATIC_CACHE; })
        .map(function (k) { return caches.delete(k); }));
    } catch (err) { /* ignore */ }
    await self.clients.claim();
  })());
});

/* ---------- IndexedDB（クッキーと内部トークンの保存） ---------- */

var dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise(function (resolve, reject) {
      var r = indexedDB.open(".nx", 1);
      r.onupgradeneeded = function () {
        var d = r.result;
        d.createObjectStore("cookie", { keyPath: "id" });
        d.createObjectStore("meta");
      };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }
  return dbPromise;
}
function tx(store, mode, fn) {
  return openDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var t = db.transaction(store, mode);
      var req = fn(t.objectStore(store));
      t.oncomplete = function () { resolve(req && req.result); };
      t.onerror = function () { reject(t.error); };
      t.onabort = function () { reject(t.error); };
    });
  });
}
function randHex() {
  var a = new Uint8Array(16);
  crypto.getRandomValues(a);
  var s = "";
  for (var i = 0; i < a.length; i++) s += ("0" + a[i].toString(16)).slice(-2);
  return s;
}

/* ---------- クッキージャー（解析・照合は common.js） ---------- */

var rwHosts = null; // 書き換えモードにするホスト(シェルから届く。IndexedDB に保存)
function nxRwMode(host) {
  var list = rwHosts || NX_RW_DEFAULT;
  host = String(host || "").toLowerCase();
  for (var i = 0; i < list.length; i++) {
    var d = list[i];
    if (host === d || host.endsWith("." + d)) return true;
  }
  return false;
}
var jar = new Map();
var dirty = new Set();
var token = "";

var ready = (async function () {
  try {
    var all = await tx("cookie", "readonly", function (s) { return s.getAll(); });
    var now = Date.now();
    (all || []).forEach(function (c) {
      if (nxIsExpired(c, now)) { tx("cookie", "readwrite", function (s) { return s.delete(c.id); }).catch(function () {}); }
      else jar.set(c.id, c);
    });
    token = await tx("meta", "readonly", function (s) { return s.get("token"); });
    if (!token) {
      token = randHex();
      await tx("meta", "readwrite", function (s) { return s.put(token, "token"); });
    }
  } catch (err) {
    if (!token) token = randHex();
  }
  try {
    var savedRw = await tx("meta", "readonly", function (s) { return s.get("rwhosts"); });
    if (rwHosts === null) rwHosts = Array.isArray(savedRw) ? savedRw : NX_RW_DEFAULT.slice();
  } catch (err) {
    if (rwHosts === null) rwHosts = NX_RW_DEFAULT.slice();
  }
})();

function putCookie(c) {
  nxPut(jar, c);
  dirty.add(c.id);
}
async function flush() {
  var ids = Array.from(dirty);
  dirty.clear();
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i], c = jar.get(id);
    try {
      if (c) await tx("cookie", "readwrite", function (s) { return s.put(c); });
      else await tx("cookie", "readwrite", function (s) { return s.delete(id); });
    } catch (err) { /* ignore */ }
  }
}
function cookieString(urlStr, includeHttpOnly) { return nxCookieString(jar, urlStr, includeHttpOnly); }

/* 変更を各ページ（window クライアント）へ配る。ページ側は document.cookie 用のコピーを持つ */
async function broadcast(msg, exceptId) {
  try {
    var cs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    cs.forEach(function (c) { if (c.id !== exceptId) c.postMessage(msg); });
  } catch (err) { /* ignore */ }
}

/* ページから: document.cookie = "..." の同期（HttpOnly は JS から設定できない） */
self.addEventListener("message", function (e) {
  var d = e.data;
  if (!d || d.t !== "setcookie") return;
  e.waitUntil((async function () {
    await ready;
    if (d.token !== token) return;
    var u;
    try { u = new URL(d.url); } catch (err) { return; }
    var c = nxParseSetCookie(d.str, u, Date.now());
    if (!c || c.httpOnly) return;
    putCookie(c);
    await flush();
    await broadcast({ t: "cookies", list: [c] }, e.source && e.source.id);
  })());
});

/* シェルから: 書き換えモードにするホストの一覧 */
self.addEventListener("message", function (e) {
  var d = e.data;
  if (!d || d.t !== "nx-rw-hosts" || !Array.isArray(d.list)) return;
  var list = d.list
    .filter(function (h) { return typeof h === "string" && h.length < 254 && /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(h); })
    .slice(0, 60)
    .map(function (h) { return h.toLowerCase(); });
  rwHosts = list;
  e.waitUntil(tx("meta", "readwrite", function (s) { return s.put(list, "rwhosts"); }).catch(function () {}));
});

/* ---------- Debug / Cache controls ---------- */
self.addEventListener("message", function (e) {
  var d = e.data || {}, src = e.source;
  if (!src) return;
  if (d.t === "nx-debug-get") {
    src.postMessage({ t: "nx-debug-state", logs: nxDebugLogs.slice(-80), cacheHits: nxDebugCacheHits, cacheName: NX_STATIC_CACHE });
  } else if (d.t === "nx-debug-clear" || d.t === "nx-debug-clear-cache") {
    e.waitUntil((async function () {
      try { await caches.delete(NX_STATIC_CACHE); } catch (err) { /* ignore */ }
      nxDebugLogs = [];
      nxDebugCacheHits = 0;
      try { src.postMessage({ t: "nx-debug-state", logs: [], cacheHits: 0, cacheName: NX_STATIC_CACHE }); } catch (err) { /* ignore */ }
    })());
  }
});

function nxShouldCache(req, url, isNav, clientUrl) {
  if (!req || (req.method !== "GET" && req.method !== "HEAD") || isNav) return false;
  // Credentialed resources must never be shared through the global static cache.
  // This avoids breaking sites whose JS/CSS/JSON varies by login or cookie state.
  try {
    if (req.headers.get("x-nx-cookie") || req.headers.get("authorization") || req.headers.get("x-nx-origin")) return false;
    if (cookieString(url.href, true)) return false;
  } catch (e) {}
  var p = String(url.pathname || "").toLowerCase();
  if (/\.(?:html?|php|cgi|aspx?)$/i.test(p)) return false;
  // ゲームの音声・動画・wasm・大きなバイナリは SW のメモリを圧迫して固まる原因になるのでキャッシュしない
  if (/\.(?:wasm|mp3|ogg|oga|wav|m4a|aac|flac|mp4|webm|mov|m3u8|mpd|ts|m4s|bin|dat|data|pck|unityweb|zip|7z|rar)$/i.test(p)) return false;
  if (/\.(?:js|mjs|css|png|jpe?g|gif|webp|svg|ico|woff2?|woff|ttf|otf|json)$/i.test(p)) return true;
  return /(?:^|\/)static(?:\/|$)|(?:^|\/)(?:assets?|_next|build|dist)(?:\/|$)/i.test(p);
}

async function nxCacheMatch(url, tag) {
  try { var c = await caches.open(NX_STATIC_CACHE); return await c.match(ORIGIN + "/_nx/cache/" + (tag || "o") + "/" + nxEncUrl(url)); } catch (e) { return null; }
}
async function nxCachePut(url, response, tag) {
  var stored = false;
  try {
    if (!response || response.status !== 200) return;
    var cc = String(response.headers.get("cache-control") || "");
    if (/no-store|private|no-cache/i.test(cc) || response.headers.get("set-cookie")) return;
    var ct = String(response.headers.get("content-type") || "");
    if (!/(javascript|css|image\/|font)/i.test(ct)) return;
    var c = await caches.open(NX_STATIC_CACHE);
    await c.put(ORIGIN + "/_nx/cache/" + (tag || "o") + "/" + nxEncUrl(url), response);
    stored = true;
  } catch (e) {
  } finally {
    if (!stored) { try { if (response && response.body) response.body.cancel(); } catch (e2) {} }
  }
}

/* ---------- fetch の横取り ---------- */

var RWP = "/~/";
function rwReal(s) {
  s = String(s || "");
  return s.indexOf(ORIGIN + RWP) === 0 ? nxRwUnwrapRest(s.slice(ORIGIN.length + RWP.length)) : "";
}
/* このリクエストが書き換えモードのページから来たなら、そのページの実URLを返す */
async function rwCtx(e) {
  var ref = e.request.referrer || "";
  if (ref.indexOf(ORIGIN + PREFIX) === 0) return ""; // SW方式のページから
  var r = "";
  if (e.clientId) {
    try { var c = await self.clients.get(e.clientId); if (c) r = rwReal(c.url); } catch (err) { /* ignore */ }
  }
  return r || rwReal(ref);
}
function rwRedirect(req, real) {
  var dest = nxRwWrap(ORIGIN, real);
  if (!dest) return fetch(req);
  return Response.redirect(dest, (req.method === "GET" || req.method === "HEAD") ? 302 : 307);
}
/* SW方式の URL(/-----)への遷移: 書き換えモード対象のサイトなら /~/ へ振り替える */
async function navDispatch(e) {
  await ready;
  var real = nxUnwrapRest(e.request.url.slice(ORIGIN.length + PREFIX.length));
  try {
    if (real && nxRwMode(new URL(real).hostname)) return rwRedirect(e.request, real);
  } catch (err) { /* ignore */ }
  return proxy(e, real);
}
/* ページが生の外部URLを直接取りに来た場合 */
async function crossOrigin(e, req) {
  var rc = await rwCtx(e);
  if (rc) return rwRedirect(req, req.url);
  return proxy(e, req.url);
}

self.addEventListener("fetch", function (e) {
  var req = e.request, u;
  try { u = new URL(req.url); } catch (err) { return; }
  if (u.origin === ORIGIN) {
    var p = u.pathname;
    if (p.indexOf("/_nx/") === 0 || p === "/" || p === "/favicon.ico") return; // 自前の資産はそのまま
    if (p.indexOf(RWP) === 0) {
      // 書き換えモードの URL: SW は触らず Worker へ。トップレベルで直接開かれたらシェルに引き取らせる
      if (NX_SHELL && req.mode === "navigate" && req.destination === "document") {
        e.respondWith(new Response(null, { status: 302, headers: { location: ORIGIN + "/_nx/home#open=" + encodeURIComponent("rw:" + req.url.slice(ORIGIN.length + RWP.length)), "cache-control": "no-store" } }));
      }
      return;
    }
    if (p.indexOf(PREFIX) === 0) {
      // トップレベルで直接開かれたプロキシ URL（ブックマーク・別タブなど）は、常駐シェルに引き取らせる
      if (NX_SHELL && req.mode === "navigate" && req.destination === "document") {
        var restShell = req.url.slice(ORIGIN.length + PREFIX.length);
        e.respondWith(new Response(null, { status: 302, headers: { location: ORIGIN + "/_nx/home#open=" + encodeURIComponent(restShell), "cache-control": "no-store" } }));
        return;
      }
      if (req.mode === "navigate") { e.respondWith(navDispatch(e)); return; }
      e.respondWith(proxy(e, nxUnwrapRest(req.url.slice(ORIGIN.length + PREFIX.length))));
      return;
    }
    e.respondWith(leaked(e, u)); // ルート相対 URL などがプロキシ自身を指してしまった場合
    return;
  }
  if (u.protocol === "http:" || u.protocol === "https:") e.respondWith(crossOrigin(e, req));
});

function unwrapUrl(s) {
  s = String(s || "");
  return s.indexOf(ORIGIN + PREFIX) === 0 ? nxUnwrapRest(s.slice(ORIGIN.length + PREFIX.length)) : "";
}
async function clientReal(e) {
  if (!e.clientId) return "";
  try {
    var c = await self.clients.get(e.clientId);
    if (c) return unwrapUrl(c.url);
  } catch (err) { /* ignore */ }
  return "";
}
async function leaked(e, u) {
  var rc = await rwCtx(e);
  if (rc) {
    try { return rwRedirect(e.request, new URL(u.pathname + u.search, rc).href); } catch (err) { /* fallthrough */ }
  }
  var real = await clientReal(e);
  if (real) {
    try { return await proxy(e, new URL(u.pathname + u.search, real).href); } catch (err) { /* fallthrough */ }
  }
  return fetch(e.request);
}

function errorResponse(req, msg, url) {
  if (req.mode === "navigate") {
    var html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Nexora</title><body style="font:15px/1.7 system-ui,sans-serif;background:#0f1017;color:#e8eaed;padding:40px 18px">' +
      "<h1 style=\"font-size:1.15rem\">読み込めませんでした</h1>" +
      "<pre style=\"white-space:pre-wrap;color:#c9d1d9\"></pre><p><a style=\"color:#8ba6ff\" href=\"" + (NX_SHELL ? "/_nx/start" : "/_nx/home") + "\">ホームに戻る</a></p>" +
      "<script>document.querySelector('pre').textContent=" + JSON.stringify(String(msg)).replace(/</g, "\\u003c") + "</script>";
    return new Response(html, { status: 502, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  return new Response(String(msg), { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function isRedirect(s) { return s === 301 || s === 302 || s === 303 || s === 307 || s === 308; }

async function proxy(e, target) {
  var req = e.request, started = Date.now(), out, cacheHit = false;
  var debugMeta = { source: "unknown", detail: "" };
  try {
    out = await proxyInner(
      e, target,
      function () { cacheHit = true; },
      function (meta) { if (meta) debugMeta = meta; }
    );
  } catch (err) {
    var message = "予期しないエラーが発生しました: " + String((err && err.message) || err);
    debugMeta = { source: "internal", detail: message };
    out = errorResponse(req, message, target);
  }
  if (cacheHit) debugMeta = { source: "cache", detail: "Static cache hit" };
  try { nxDebugRecord(req.method, target, out && out.status, Date.now() - started, cacheHit, debugMeta); } catch (e2) {}
  return out;
}

async function proxyInner(e, target, markCacheHit, markDebug) {
  await ready;
  var req = e.request;
  if (!target) return errorResponse(req, "URL を読み取れませんでした（キーが変わった古いリンクかもしれません）", "");
  for (var sr = 0; sr < 4 && target.indexOf(ORIGIN + PREFIX) === 0; sr++) {
    var inner = nxUnwrapRest(target.slice(ORIGIN.length + PREFIX.length));
    if (!inner) break;
    target = inner;
  }
  if (!/^https?:\/\//i.test(target)) target = "https://" + target;
  try {
    var leak = new URL(target);
    if (leak.pathname.indexOf(PREFIX) === 0) {
      var leakReal = nxUnwrapRest(leak.pathname.slice(PREFIX.length) + leak.search + leak.hash);
      if (leakReal && /^https?:\/\//i.test(leakReal)) target = leakReal;
    }
  } catch (err) { /* ignore */ }
  var parsedTarget;
  try { parsedTarget = new URL(target); } catch (err) { return errorResponse(req, "URL が不正です", target); }

  var isNav = req.mode === "navigate";
  var clientUrl = isNav ? unwrapUrl(req.referrer) : (await clientReal(e)) || unwrapUrl(req.referrer);
  if (nxShouldCache(req, parsedTarget, isNav, clientUrl)) {
    var ctag = req.destination === "script" ? "s" : "o";
    var cached = await nxCacheMatch(parsedTarget.href, ctag);
    if (cached) {
      if (markCacheHit) markCacheHit();
      nxDebugCacheHits++;
      return cached;
    }
  }

  var method = req.method, body = null;
  if (method !== "GET" && method !== "HEAD") {
    try { body = await req.arrayBuffer(); } catch (err) { return errorResponse(req, "リクエスト本文を読み取れませんでした: " + String((err && err.message) || err), target); }
  }

  var url = target, redirects = 0;
  for (;;) {
    var nextAsset = nxIsNextAsset(url) && (req.destination === "script" || req.destination === "style" || /\/\_next\//i.test(new URL(url).pathname));
    var r = await relayOnce(e, req, url, method, body, clientUrl, false);
    if (r.error) {
      if (markDebug) markDebug({ source: r.errorType || "relay", detail: r.error });
      return errorResponse(req, r.error, url);
    }
    /* Next.js の静的チャンクは CDN / ブラウザキャッシュ由来の一時的な 404/5xx を
       そのまま確定させず、一度だけ no-store で再取得する。 */
    if (nextAsset && (r.status === 404 || r.status === 408 || r.status === 429 || r.status >= 500)) {
      var retry = await relayOnce(e, req, url, method, body, clientUrl, true);
      if (!retry.error && retry.status && retry.status < r.status || (!retry.error && retry.status >= 200 && retry.status < 400)) r = retry;
    }
    if (markDebug) {
      markDebug({
        source: "upstream",
        detail: "Upstream HTTP " + r.status + (r.videoDiag ? " | " + r.videoDiag : ""),
        serverMs: Number(r.res && r.res.headers.get("x-nx-server-ms") || 0)
      });
    }
    var loc = r.headers.get("location");
    if (isRedirect(r.status) && loc && req.redirect !== "error") {
      var abs = null;
      try { abs = new URL(loc, url).href; } catch (err) { abs = null; }
      if (abs) {
        if (isNav || req.redirect === "manual") {
          return new Response(null, { status: r.status, headers: { location: isNav ? nxWrapUrl(ORIGIN, abs) : abs, "cache-control": "no-store" } });
        }
        if (++redirects > MAX_REDIRECTS) return errorResponse(req, "リダイレクトが多すぎます", url);
        if (r.status === 303 || ((r.status === 301 || r.status === 302) && method === "POST")) { method = "GET"; body = null; }
        url = abs;
        continue;
      }
    }
    var finalResponse = await buildResponse(e, req, r, url, isNav);
    if (nxShouldCache(req, new URL(url), isNav, clientUrl) && finalResponse && finalResponse.ok) {
      e.waitUntil(nxCachePut(url, finalResponse.clone(), ctag));
    }
    return finalResponse;
  }
}

function cookieFor(req, url, clientUrl) {
  if (req.credentials === "omit") return "";
  if (req.credentials === "same-origin" && clientUrl) {
    try { if (new URL(clientUrl).origin !== new URL(url).origin) return ""; } catch (err) { /* ignore */ }
  }
  return cookieString(url, true);
}

/* Sec-Fetch-Site は Service Worker の Request.headers から取得できないため、
 * clientUrl と取得先 URL から判定する。same-site は誤判定を避けるため使わない。 */
function nxFetchSite(clientUrl, targetUrl) {
  if (!clientUrl) return "none";
  try {
    var a = new URL(clientUrl), b = new URL(targetUrl);
    return a.origin === b.origin ? "same-origin" : "cross-site";
  } catch (e) { return null; }
}

async function relayOnce(e, req, url, method, body, clientUrl, forceNoStore) {
  var h = new Headers();
  req.headers.forEach(function (v, k) { if (!/^x-nx-/i.test(k)) { try { h.set(k, v); } catch (err) { /* ignore */ } } });
  var cookie = cookieFor(req, url, clientUrl);
  if (cookie) { try { h.set("x-nx-cookie", cookie); } catch (err) { /* ignore */ } }
  if (clientUrl) { try { h.set("x-nx-referer", clientUrl); } catch (err) { /* ignore */ } }
  // Fetch Metadata は Worker 側で一度除外されるため、x-nx-* 経由で明示的に引き継ぐ。
  try {
    var fetchSite = nxFetchSite(clientUrl, url);
    if (fetchSite) h.set("x-nx-fetch-site", fetchSite);
  } catch (err) { /* ignore */ }
  try { if (req.mode) h.set("x-nx-fetch-mode", req.mode); } catch (err) { /* ignore */ }
  try { if (req.destination) h.set("x-nx-fetch-dest", req.destination); } catch (err) { /* ignore */ }
  if ((method !== "GET" && method !== "HEAD") || req.mode === "cors") {
    try { h.set("x-nx-origin", new URL(clientUrl || url).origin); } catch (err) { /* ignore */ }
  }
  var res = await fetchRelay(RELAY + nxEncUrl(url), {
    method: method, headers: h, body: body || undefined, redirect: "manual", credentials: "omit",
    cache: forceNoStore ? "no-store" : (req.cache === "only-if-cached" ? "default" : req.cache), signal: req.signal
  });
  if (res.__nxTimeout) return { error: "ブラウザ→Worker 中継がタイムアウトしました (" + RELAY_TIMEOUT_MS + "ms)", errorType: "relay-timeout" };
  if (res.__nxError) return { error: "ブラウザ→Worker 中継エラー: " + String((res.__nxError && res.__nxError.message) || res.__nxError), errorType: "relay-fetch" };
  var xe = res.headers.get("x-nx-error");
  if (xe) {
    try { xe = decodeURIComponent(xe); } catch (err) { /* ignore */ }
    var upstreamTimedOut = /upstream timeout/i.test(xe);
    return {
      error: upstreamTimedOut ? "上流サーバーの応答待ちがタイムアウトしました: " + xe : "Worker→上流接続エラー: " + xe,
      errorType: upstreamTimedOut ? "upstream-timeout" : "upstream-connect"
    };
  }
  var status = parseInt(res.headers.get("x-nx-status") || "0", 10);
  if (!status) return { error: "中継サーバーの応答が不正です (Worker HTTP " + res.status + ")", errorType: "relay-response" };

  var videoDiag = res.headers.get("x-nx-diag-video") || "";
  if (videoDiag) { try { videoDiag = decodeURIComponent(videoDiag); } catch (err) {} }

  var headers = new Headers(), changedList = [], now = Date.now(), cu = new URL(url);
  res.headers.forEach(function (v, k) {
    if (k.indexOf("x-nx-h-") === 0) { try { headers.append(k.slice(7), v); } catch (err) { /* ignore */ } }
    else if (k.indexOf("x-nx-sc-") === 0 && req.credentials !== "omit") {
      var c = nxParseSetCookie(v, cu, now);
      if (c) { putCookie(c); changedList.push(c); }
    }
  });
  if (changedList.length) {
    e.waitUntil(flush());
    await broadcast({ t: "cookies", list: changedList }); // ページが結果を受け取る前に配る
  }
  var st = res.headers.get("x-nx-status-text") || "";
  try { st = decodeURIComponent(st); } catch (err) { st = ""; }
  return { status: status, statusText: st, headers: headers, body: res.body, res: res, videoDiag: videoDiag };
}

function injectPrelude(body, prelude) {
  var reader = body ? body.getReader() : null;
  return new ReadableStream({
    start: function (c) { c.enqueue(ENC.encode(prelude)); },
    pull: function (c) {
      if (!reader) { c.close(); return; }
      return reader.read().then(function (r) { if (r.done) c.close(); else c.enqueue(r.value); });
    },
    cancel: function (reason) { if (reader) return reader.cancel(reason); }
  });
}

function escAttr(s) { return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }

/*
 * ページ遷移時のローディング演出。
 * オーバーレイの要素は HTML 文字列へ直接挿入せず、ページ側 JavaScript から DOM API で生成する。
 * これにより <head> 内へ不正な <div> が流れ込み、HTML パーサーの状態を壊すことを防ぐ。
 */
var TRANSITION_SCRIPT = '<script data-nx-trans>(function(){' +
  'if(window.__nxTransBoot||window.__nxLite)return;window.__nxTransBoot=true;' +
  'var d=document,shown=Date.now(),MIN=200,el=null;' +
  'var css=d.createElement("style");css.setAttribute("data-nx","");' +
  'css.textContent="#nx-trans{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);overflow:hidden;pointer-events:none;transition:opacity .45s ease;opacity:1}"+' +
  '"#nx-trans.nx-out{opacity:0;pointer-events:none}"+' +
  '"#nx-trans__sweep{position:absolute;inset:0;background:repeating-linear-gradient(120deg,transparent 0 26%,rgba(102,126,234,.04) 32%,rgba(102,126,234,.35) 36%,rgba(102,126,234,.04) 40%,transparent 46% 72%);background-size:220% 220%;animation:nxsweep 3.2s linear infinite}"+' +
  '"@keyframes nxsweep{0%{background-position:0% 0%}100%{background-position:100% 100%}}"+' +
  '"#nx-trans__mid{position:relative;text-align:center}"+' +
  '"#nx-trans__word{font:700 1.3rem/1 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;letter-spacing:.35em;background:linear-gradient(90deg,#667eea,#764ba2,#667eea);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:18px}"+' +
  '"#nx-trans__dots{display:flex;gap:8px;justify-content:center;margin-top:18px}"+' +
  '"#nx-trans__dots span{width:8px;height:8px;border-radius:50%;background:#8ba6ff;animation:nxdot 1s ease-in-out infinite}"+' +
  '"#nx-trans__dots span:nth-child(2){animation-delay:.15s}#nx-trans__dots span:nth-child(3){animation-delay:.3s}"+' +
  '"@keyframes nxdot{0%,80%,100%{transform:scale(.6);opacity:.4}40%{transform:scale(1);opacity:1}}";' +
  'function hide(){if(!el||!el.parentNode)return;var wait=Math.max(0,MIN-(Date.now()-shown));setTimeout(function(){if(!el)return;el.classList.add("nx-out");setTimeout(function(){if(el&&el.parentNode)el.parentNode.removeChild(el);el=null},500)},wait)}' +
  'function mount(){if(el||!d.body)return;' +
  'el=d.createElement("div");el.id="nx-trans";el.setAttribute("aria-hidden","true");' +
  'var sweep=d.createElement("div");sweep.id="nx-trans__sweep";' +
  'var mid=d.createElement("div");mid.id="nx-trans__mid";' +
  'var word=d.createElement("div");word.id="nx-trans__word";word.textContent="NEXORA";' +
  'var dots=d.createElement("div");dots.id="nx-trans__dots";' +
  'for(var i=0;i<3;i++)dots.appendChild(d.createElement("span"));' +
  'mid.appendChild(word);mid.appendChild(dots);el.appendChild(sweep);el.appendChild(mid);d.body.appendChild(el);' +
  'if(d.readyState==="complete")hide();else window.addEventListener("load",hide,{once:true});' +
  'if(d.readyState==="loading")d.addEventListener("DOMContentLoaded",function(){setTimeout(hide,700)},{once:true});else setTimeout(hide,700);' +
  'setTimeout(hide,2500);' +
  '}' +
  'var head=d.head||d.documentElement;if(head)head.appendChild(css);' +
  'if(d.body)mount();else{var mo=new MutationObserver(function(){if(d.body){mo.disconnect();mount()}});try{mo.observe(d.documentElement,{childList:true});}catch(e){d.addEventListener("DOMContentLoaded",mount,{once:true})}}' +
  '})();</script>';

/* シェル内のタブ（トップ = シェル、その直下のフレーム）かどうかをページ側で判定する式 */
var NX_TABROOT_GATE = "(function(){try{return window.parent===window.top&&window.top!==window&&window.top.document.documentElement.hasAttribute('data-nx-shell')}catch(e){return false}})()";
function nxDiagPrelude(gated) {
  var code = "(function(w){if(w.__nxDiag)return;var d=w.__nxDiag={errors:[],startedAt:Date.now()};function add(k,m,s,l,c,st){try{var kind=String(k||'error'),message=String(m||k||'Error'),source=String(s||'');if(kind==='resource'){for(var i=d.errors.length-1;i>=0;i--){var old=d.errors[i];if(old.kind==='resource'&&old.source===source&&old.message===message){old.count=(old.count||1)+1;old.time=new Date().toLocaleTimeString();return}}}d.errors.push({kind:kind,message:message,source:source,line:Number(l)||0,column:Number(c)||0,stack:String(st||''),time:new Date().toLocaleTimeString(),count:1});if(d.errors.length>100)d.errors.splice(0,d.errors.length-100)}catch(x){}}d.add=add;w.addEventListener('error',function(e){var t=e&&e.target;if(t&&t!==w){var u=t.src||t.href||'';add('resource','Failed to load '+(u||t.tagName),u,0,0,'');return}add('error',e&&e.message||'Script error',e&&e.filename,e&&e.lineno,e&&e.colno,e&&e.error&&e.error.stack)},true);w.addEventListener('unhandledrejection',function(e){var r=e&&e.reason;add('rejection',r&&r.message||String(r),'',0,0,r&&r.stack||'')},true);try{var c=w.console,old=c&&c.error;if(c&&typeof old==='function'&&!c.__nxDiagWrapped){var f=function(){var a=Array.prototype.slice.call(arguments);add('console.error',a.map(function(x){try{return x&&x.stack||String(x)}catch(z){return '[unprintable]'}}).join(' '),'',0,0,a.map(function(x){return x&&x.stack||''}).join('\\n'));return old.apply(this,arguments)};c.error=f;try{Object.defineProperty(c,'__nxDiagWrapped',{value:true})}catch(z){c.__nxDiagWrapped=true}}}catch(x){}})(window);";
  return "<script data-nx-diag>" + (gated ? "if(" + NX_TABROOT_GATE + "){" : "") + code + (gated ? "}" : "") + "</script>";
}

function preludeFor(realUrl, topLevel, tabFrame) {
  var host = "";
  try { host = new URL(realUrl).hostname.toLowerCase(); } catch (err) { /* ignore */ }
  var boot = JSON.stringify({ t: token, u: realUrl, c: nxCookiesForHost(jar, host) }).replace(/</g, "\\u003c");
  return '<!doctype html>' +
    (nxIsGameHost(host) ? "" : '<meta data-nx http-equiv="content-security-policy" content="frame-src \'self\' \'unsafe-inline\' data: blob:; object-src \'self\' \'unsafe-inline\' data: blob:">') +
    '<base data-nx href="' + escAttr(realUrl) + '">' +
    (topLevel ? '<title data-nx>Nexora</title><link data-nx rel="icon" href="' + ORIGIN + '/favicon.ico">' : "") +
    "<script data-nx-boot>self.__nx_b=" + boot + ";try{self.__nxLite=localStorage.getItem('__nx_lite')==='1'}catch(e){}" + (topLevel || tabFrame ? "try{" + (topLevel ? "" : "if(" + NX_TABROOT_GATE + ")") + "localStorage.setItem('__nx_last_session'," + JSON.stringify(realUrl).replace(/</g,"\\u003c") + ");}catch(e){}" : "") + "</script>" +
    (topLevel ? nxDiagPrelude(false) : (tabFrame ? nxDiagPrelude(true) : "")) +
    '<script src="' + HELPER_URL + '"></script>' +
    (NX_TRANS ? (topLevel ? TRANSITION_SCRIPT : (tabFrame ? TRANSITION_SCRIPT.replace("<script data-nx-trans>(function(){", "<script data-nx-trans>if(" + NX_TABROOT_GATE + ")(function(){") : "")) : "") +
    (topLevel ? NX_DEBUG_UI : "");
}

async function buildResponse(e, req, r, url, isNav) {
  var h = r.headers, status = r.status, st = r.statusText;
  // COOP / COEP は残す（SharedArrayBuffer を使うゲーム向け）。require-corp は外部資源を壊すので緩める
  var coep = h.get("cross-origin-embedder-policy");
  if (coep) { if (/require-corp|credentialless/i.test(coep)) h.set("cross-origin-embedder-policy", "credentialless"); else h.delete("cross-origin-embedder-policy"); }
  var coop = h.get("cross-origin-opener-policy");
  if (coop) h.set("cross-origin-opener-policy", coop.split(";")[0].trim());

  // HTTP の Refresh ヘッダ（リダイレクト相当）の URL もプロキシ内に向ける
  var rf = h.get("refresh");
  if (rf && isNav) {
    h.set("refresh", rf.replace(/(;\s*url\s*=\s*)(.+)$/i, function (m, p, u) {
      try { return p + nxWrapUrl(ORIGIN, new URL(u.trim().replace(/^['"]|['"]$/g, ""), url).href); } catch (err) { return m; }
    }));
  }

  if (status === 204 || status === 205 || status === 304 || req.method === "HEAD" || !r.body) {
    return new Response(null, { status: status, statusText: st, headers: h });
  }
  var ct = h.get("content-type") || "";
  var isHtml = /^text\/html|application\/xhtml\+xml/i.test(ct);
  var attach = /^attachment/i.test(h.get("content-disposition") || "");

  if (isNav && isHtml && !attach) {
    var topLevel = req.destination === "document" || req.destination === "";
    var tabFrame = NX_SHELL && !topLevel && req.destination === "iframe"; // シェルのタブ候補（実際にタブの根かどうかはページ側のゲートで判定）
    return new Response(injectPrelude(r.body, preludeFor(url, topLevel, tabFrame)), { status: status, statusText: st, headers: h });
  }

  if (req.destination === "script") {
    var client = null;
    try { client = e.clientId ? await self.clients.get(e.clientId) : null; } catch (err) { /* ignore */ }
    if (!client || (client.type === "window" && unwrapUrl(client.url))) {
      var buf = await r.res.arrayBuffer();
      if (nxIsNextAsset(url) && nxLooksLikeHtml(new Uint8Array(buf))) {
        return nxAssetFailureResponse(status >= 400 ? status : 404, "js", url);
      }
      /* Next.js コアランタイムは原文のまま返す。
       * 特に main.js の HeadManager/updateHead はブラウザ標準の
       * location 等の意味に依存するため、識別子変換の対象から外す。 */
      if (nxIsNextRuntimeScript(url)) {
        return new Response(buf, { status: status, statusText: st, headers: h });
      }
      var out = nxRewriteJs(DEC.decode(buf));
      return new Response(out === null ? buf : ENC.encode(out), { status: status, statusText: st, headers: h });
    }
  }
  if (req.destination === "style" && nxIsNextAsset(url)) {
    var cssBuf = await r.res.arrayBuffer();
    if (nxLooksLikeHtml(new Uint8Array(cssBuf))) {
      return nxAssetFailureResponse(status >= 400 ? status : 404, "css", url);
    }
    return new Response(cssBuf, { status: status, statusText: st, headers: h });
  }
  return new Response(r.body, { status: status, statusText: st, headers: h });
}
`;
const HELPER_SRC = String.raw`/* ============================== Nexora ページ側ヘルパー ============================== */

var BOOT = self.__nx_b || { t: "", u: "", c: [] };
try { delete self.__nx_b; } catch (e) { /* ignore */ }
try { var bootEl = document.querySelector("script[data-nx-boot]"); if (bootEl) bootEl.remove(); } catch (e) { /* ignore */ }
var TOKEN = BOOT.t;
var ORIGIN = self.location.origin;
var PREFIX = NX_CFG.prefix;
var WRAP_HEAD = ORIGIN + PREFIX;
var TOP_NATIVE_LS = null;
try { TOP_NATIVE_LS = self.localStorage; } catch (e) { /* ignore */ }

function wrap(u) { return nxWrapUrl(ORIGIN, unwrapStr(u)); }
function unwrapStr(u) {
  u = String(u);
  if (u.indexOf(WRAP_HEAD) !== 0) return u;
  var r = nxUnwrapRest(u.slice(WRAP_HEAD.length));
  return r || u;
}
function isHttpUrl(u) { return /^https?:/i.test(u); }

/* クッキーのコピー（非 HttpOnly だけ document.cookie に見せる。HttpOnly は WebSocket の接続用に保持するだけ） */
var PAGE_HOST = "";
try { PAGE_HOST = new URL(BOOT.u).hostname.toLowerCase(); } catch (e) { /* ignore */ }
var NX_GAME_MODE = nxIsGameHost(PAGE_HOST);
var JAR = new Map();
(BOOT.c || []).forEach(function (c) { nxPut(JAR, c); });
try {
  var swc0 = navigator.serviceWorker;
  if (swc0) {
    // ページのスクリプトより先に登録し、他のリスナーへは流さない（HttpOnly の値が見えてしまうため）
    swc0.addEventListener("message", function (e) {
      var d = e.data;
      if (!d || d.t !== "cookies") return;
      e.stopImmediatePropagation();
      (d.list || []).forEach(function (c) { if (PAGE_HOST && nxHostMatch(c, PAGE_HOST)) nxPut(JAR, c); });
    }, true);
    if (swc0.startMessages) swc0.startMessages();
  }
} catch (e) { /* ignore */ }
function sendCookieToSw(real, str) {
  try {
    var c = navigator.serviceWorker.controller;
    if (c) c.postMessage({ t: "setcookie", token: TOKEN, url: real, str: str });
  } catch (e) { /* ignore */ }
}

/* ある window にフックを仕込む（iframe の about:blank などにも再利用する） */
function init(win) {
  try {
    if (win.__nx_done) return;
    Object.defineProperty(win, "__nx_done", { value: true });
  } catch (e) { return; }

  var doc = win.document;
  var nloc = win.location;
  var Obj = win.Object;
  var nativeReplaceState = win.History.prototype.replaceState;
  var nativeGetAttr = win.Element.prototype.getAttribute;
  var nativeSetAttr = win.Element.prototype.setAttribute;

  function real() { return unwrapStr(nloc.href); }
  // ナビバー表示用: 復号できなくても暗号化 URL を絶対に返さない
  var __barLast = "";
  function barReal() {
    var u = "";
    try { u = unwrapStr(nloc.href); } catch (e) { u = ""; }
    if (u && u.indexOf(WRAP_HEAD) !== 0) { __barLast = u; return u; }
    try {
      var rest = String(nloc.href).slice(WRAP_HEAD.length).split("#")[0];
      var seg = rest.split(/[\/?]/)[0];
      var d = seg ? nxDecUrl(seg) : null;
      if (d && isHttpUrl(d)) { __barLast = d; return d; }
    } catch (e) { /* ignore */ }
    try {
      var b = doc.baseURI;
      if (b && isHttpUrl(b) && b.indexOf(WRAP_HEAD) !== 0) { __barLast = b; return b; }
    } catch (e) { /* ignore */ }
    return __barLast || BOOT.u || "";
  }
  /* ---- Nexora 3.0: シェルとの連携（タブの根フレームだけが報告する） ---- */
  var DOCID = Math.random().toString(36).slice(2) + Date.now().toString(36);
  var LITE = false; try { LITE = !!TOP_NATIVE_LS && TOP_NATIVE_LS.getItem("__nx_lite") === "1"; } catch (e) { LITE = false; }
  var nativePost = win.postMessage; // 下で差し替える前の本物
  function inShell() {
    try { return win.parent !== win && win.parent === win.top && win.top.document.documentElement.hasAttribute("data-nx-shell"); } catch (e) { return false; }
  }
  function shellApi() { try { return inShell() ? win.top.__nxShell : null; } catch (e) { return null; } }
  var __lastTitle = null;
  function shellReport(t) {
    if (!inShell()) return;
    try { nativePost.call(win.parent, { __nx: "nav", t: t, url: barReal(), doc: DOCID, title: doc.title || "" }, ORIGIN); } catch (e) { /* ignore */ }
  }
  function RU() { try { return new win.URL(real()); } catch (e) { return new win.URL("about:blank"); } }
  function baseHref() {
    var b = doc.baseURI;
    if (isHttpUrl(b)) return b;
    try { if (win.parent !== win) return win.parent.document.baseURI; } catch (e) { /* ignore */ }
    return b;
  }
  function resolve(u) {
    try {
      var r = new win.URL(String(u), baseHref());
      if (r.pathname.indexOf(PREFIX) === 0) {
        // "/-----token" glued onto a real (or the Nexora) origin: it is Nexora's own encrypted path, not a site path
        var x = nxUnwrapRest(r.pathname.slice(PREFIX.length) + r.search + r.hash);
        if (x && isHttpUrl(x)) return new win.URL(x);
      }
      return r;
    } catch (e) { return null; }
  }

  /* 文字列 URL → ナビゲーション用（プロキシ経由）の URL。対象外のものはそのまま返す */
  function toWrapped(u) {
    var s = String(u);
    if (s.indexOf(WRAP_HEAD) === 0) return s;
    var t = s.trim();
    if (/^javascript:/i.test(t)) { var o = nxRewriteJs(t); return o === null ? s : o; }
    if (/^(data|blob|about|mailto|tel|sms|geo):/i.test(t)) return s;
    var r = resolve(s);
    if (r && (r.protocol === "http:" || r.protocol === "https:")) return wrap(r.href);
    return s;
  }

  function hook(proto, name, gf, sf) {
    try {
      var o = Obj.getOwnPropertyDescriptor(proto, name);
      if (!o) return;
      var nd = { configurable: true, enumerable: o.enumerable };
      if (o.get) nd.get = gf ? function () { return gf.call(this, o.get.call(this)); } : o.get;
      if (o.set) nd.set = sf ? function (v) { o.set.call(this, sf.call(this, v)); } : o.set;
      Obj.defineProperty(proto, name, nd);
    } catch (e) { /* ignore */ }
  }

  /* フォームの GET 送信などでブラウザが付けた生のクエリは、読み込み直後に難読化した URL へ置き換える */
  try {
    if (nloc.search && nloc.href.indexOf(WRAP_HEAD) === 0 && isHttpUrl(real())) {
      nativeReplaceState.call(win.history, win.history.state, "", wrap(real()));
    }
  } catch (e) { /* ignore */ }

  /* ---------- location の仮想化 ---------- */
  var fake = {
    get href() { return real(); },
    set href(v) { nloc.href = toWrapped(v); },
    get origin() { return RU().origin; },
    get protocol() { return RU().protocol; },
    set protocol(v) { var u = RU(); u.protocol = v; nloc.href = wrap(u.href); },
    get host() { return RU().host; },
    set host(v) { var u = RU(); u.host = v; nloc.href = wrap(u.href); },
    get hostname() { return RU().hostname; },
    set hostname(v) { var u = RU(); u.hostname = v; nloc.href = wrap(u.href); },
    get port() { return RU().port; },
    set port(v) { var u = RU(); u.port = v; nloc.href = wrap(u.href); },
    get pathname() { return RU().pathname; },
    set pathname(v) { var u = RU(); u.pathname = v; nloc.href = wrap(u.href); },
    get search() { return RU().search; },
    set search(v) { var u = RU(); u.search = v; nloc.href = wrap(u.href); },
    get hash() { return nloc.hash; },
    set hash(v) { nloc.hash = v; },
    get ancestorOrigins() { return nloc.ancestorOrigins; },
    assign: function (v) { nloc.assign(toWrapped(v)); },
    replace: function (v) { nloc.replace(toWrapped(v)); },
    reload: function () { nloc.reload(); },
    toString: function () { return real(); },
    toLocaleString: function () { return real(); }
  };
  try { Obj.setPrototypeOf(fake, win.Location.prototype); } catch (e) { /* ignore */ }
  var locDesc = { get: function () { return fake; }, set: function (v) { fake.href = v; }, configurable: true };
  try { Obj.defineProperty(win, "__location", locDesc); } catch (e) { /* ignore */ }
  try { Obj.defineProperty(doc, "__location", locDesc); } catch (e) { /* ignore */ }
  // location という名前のただのプロパティ（JSON の location キー、KeyboardEvent.location など）への読み書き用
  try {
    Obj.defineProperty(Obj.prototype, "__location", {
      get: function () { if (this && typeof this.nodeType === "number" && this.nodeType > 0 && this.nodeType < 12) return fake; return this.location; },
      set: function (v) {
        if (this && typeof this.nodeType === "number" && this.nodeType > 0 && this.nodeType < 12) { fake.href = v; return; }
        try { Obj.defineProperty(this, "location", { value: v, writable: true, configurable: true, enumerable: true }); } catch (e) { /* ignore */ }
      },
      configurable: true, enumerable: false
    });
  } catch (e) { /* ignore */ }

  /* ---------- document / window の URL 系プロパティ ---------- */
  var unw = function (v) { return unwrapStr(v); };
  hook(win.Document.prototype, "URL", unw);
  hook(win.Document.prototype, "documentURI", unw);
  hook(win.Document.prototype, "referrer", unw);
  hook(win.Document.prototype, "domain", function () { return RU().hostname; }, function () { return RU().hostname; });
  try {
    Obj.defineProperty(win, "origin", { get: function () { return RU().origin; }, configurable: true });
  } catch (e) { /* ignore */ }
  try { Obj.defineProperty(win, "__nx_origin", { value: function () { return historyOrigin(); }, configurable: true }); } catch (e) { /* ignore */ }

  /* ---------- document.cookie（ページ側のコピー + SW へメッセージで同期） ---------- */
  try {
    var cd = Obj.getOwnPropertyDescriptor(win.Document.prototype, "cookie");
    Obj.defineProperty(win.Document.prototype, "cookie", {
      configurable: true, enumerable: cd.enumerable,
      get: function () { var r = real(); return isHttpUrl(r) ? nxCookieString(JAR, r, false) : ""; },
      set: function (v) {
        var r = real();
        if (!isHttpUrl(r)) return;
        var c;
        try { c = nxParseSetCookie(String(v), new URL(r), Date.now()); } catch (e) { return; }
        if (!c || c.httpOnly) return; // JS からは HttpOnly を作れない
        nxPut(JAR, c);
        sendCookieToSw(r, String(v));
      }
    });
  } catch (e) { /* ignore */ }

  /* ---------- タブのタイトル / favicon を隠す（履歴・タブ一覧で元サイトが分からないようにする） ---------- */
  if (win === win.top) {
    try {
      var titleDesc = Obj.getOwnPropertyDescriptor(win.Document.prototype, "title");
      if (titleDesc && titleDesc.set) {
        Obj.defineProperty(win.Document.prototype, "title", {
          configurable: true, enumerable: titleDesc.enumerable,
          get: titleDesc.get,
          set: function () { /* 元サイトによるタブタイトルの書き換えを無視する */ }
        });
      }
    } catch (e) { /* ignore */ }
    try {
      var iconDesc = Obj.getOwnPropertyDescriptor(win.HTMLLinkElement.prototype, "href");
      if (iconDesc && iconDesc.set) {
        Obj.defineProperty(win.HTMLLinkElement.prototype, "href", {
          configurable: true, enumerable: iconDesc.enumerable,
          get: iconDesc.get,
          set: function (v) {
            var rel = (nativeGetAttr.call(this, "rel") || "").toLowerCase();
            if (nativeGetAttr.call(this, "data-nx") === null && /(^|\s)(icon|shortcut icon|apple-touch-icon|apple-touch-icon-precomposed|mask-icon)(\s|$)/.test(rel)) return;
            iconDesc.set.call(this, v);
          }
        });
      }
    } catch (e) { /* ignore */ }
  }

  /* ---------- history ---------- */
  function updateBase() {
    try {
      var b = doc.querySelector("base[data-nx]");
      var r = real();
      if (b && isHttpUrl(r)) b.href = r;
    } catch (e) { /* ignore */ }
  }

  // about:blank の iframe は親のオリジンを継承する。
  // RU() だけを見ると about:blank の origin は "null" になるため、
  // History の同一オリジン判定では親から継承した仮想オリジンを使う。
  function historyOrigin() {
    var cur = RU();
    if (cur.origin !== "null") return cur.origin;

    try {
      if (win.parent !== win) {
        var parentOrigin = win.parent.__nx_origin;
        if (typeof parentOrigin === "function") {
          var inherited = parentOrigin();
          if (inherited && inherited !== "null") return inherited;
        }

        // 親の helper がまだ初期化されていない場合のフォールバック。
        // 親の location はプロキシ URL なので、実 URL に戻して origin を取得する。
        var parentHref = unwrapStr(win.parent.location.href);
        var parentUrl = new win.URL(parentHref);
        if (isHttpUrl(parentUrl.href)) return parentUrl.origin;
      }
    } catch (e) { /* 親にアクセスできない場合は元の origin を使う */ }

    return cur.origin;
  }

  ["pushState", "replaceState"].forEach(function (k) {
    var o = win.History.prototype[k];
    win.History.prototype[k] = function (s, t, u) {
      if (u !== undefined && u !== null && u !== "") {
        var r = resolve(u);
        if (r) {
          var cur = RU();
          var curOrigin = historyOrigin();

          // 実オリジンを判定できない about:blank 等では、ここで独自の SecurityError を作らず
          // History API 本来の判定に任せる。判定可能な場合だけ実オリジンを照合する。
          if (curOrigin !== "null" && r.origin !== curOrigin) {
            throw new win.DOMException(
              "Failed to execute '" + k + "' on 'History': A history state object with URL '" + u +
              "' cannot be created in a document with origin '" + curOrigin + "' and URL '" + cur.href + "'.",
              "SecurityError"
            );
          }
          u = wrap(r.href);
        }
      }
      var rv = o.call(this, s, t, u);
      updateBase();
      shellReport(k === "pushState" ? "push" : "replace");
      return rv;
    };
  });
  win.addEventListener("popstate", updateBase);
  win.addEventListener("hashchange", updateBase);
  win.addEventListener("popstate", function () { shellReport("nav"); });
  win.addEventListener("hashchange", function () { shellReport("nav"); });

  /* ---------- window.open ---------- */
  var wo = win.open;
  win.open = function (u, target) {
    var a = Array.prototype.slice.call(arguments);
    if (u !== undefined && u !== null && u !== "") {
      var api = shellApi();
      if (api) {
        var tg = String(target === undefined || target === null || target === "" ? "_blank" : target).toLowerCase();
        if (tg === "_self" || tg === "_top" || tg === "_parent") { nloc.href = toWrapped(u); return win; }
        if (tg === "_blank") {
          var rr = resolve(unwrapStr(String(u)));
          if (rr && (rr.protocol === "http:" || rr.protocol === "https:")) {
            var nw = api.openTab(rr.href);
            if (nw) return nw;
          }
        }
      }
      a[0] = toWrapped(u);
    }
    return wo.apply(this, a);
  };

  /*
   * postMessage: 全ウィンドウが同一オリジン（プロキシ）なので、本来のオリジンを使う targetOrigin / event.origin / event.source が合わない。
   * そこでペイロードに「送信元の本来のオリジン」と「送信元ウィンドウ ID」を載せ、受信側で data / origin / source を元に戻す。
   * 送信元は、書き換えた呼び出し箇所（X.postMessage(...(self.__nx_sw?...)) ）が top.__nx_src に記録する。
   */
  var topWin = null;
  try { topWin = win.top; } catch (e) { /* ignore */ }
  function topReg() {
    try {
      if (!topWin.__nx_wins) Obj.defineProperty(topWin, "__nx_wins", { value: [] });
      return topWin.__nx_wins;
    } catch (e) { return null; }
  }
  function winId(w) {
    var reg = topReg();
    if (!reg) return 0;
    for (var i = 0; i < reg.length; i++) if (reg[i].deref() === w) return i + 1;
    reg.push(new WeakRef(w));
    return reg.length;
  }
  function winById(id) {
    var reg = topReg(), r = reg && reg[id - 1];
    return r ? r.deref() : undefined;
  }
  try {
    Obj.defineProperty(win, "__nx_sw", {
      value: function () {
        try { topWin.__nx_src = win; Promise.resolve().then(function () { topWin.__nx_src = null; }); } catch (e) { /* ignore */ }
        return [];
      }, configurable: true
    });
  } catch (e) { /* ignore */ }
  var pm = win.postMessage;
  win.postMessage = function (m, o, t) {
    var src = null;
    try { src = topWin.__nx_src || null; topWin.__nx_src = null; } catch (e) { /* ignore */ }
    var env = { __nx_pm: 1, o: src ? src.__nx_origin() : null, id: src ? winId(src) : 0, d: m };
    if (o && typeof o === "object" && !Array.isArray(o)) {
      var opt = { targetOrigin: "*" };
      if (o.transfer) opt.transfer = o.transfer;
      return pm.call(this, env, opt);
    }
    return pm.call(this, env, "*", Array.isArray(t) ? t : undefined);
  };
  var meProto = win.MessageEvent.prototype;
  var dataDesc = Obj.getOwnPropertyDescriptor(meProto, "data");
  function rawData(ev) { try { return dataDesc.get.call(ev); } catch (e) { return undefined; } }
  hook(meProto, "data", function (v) { return v && v.__nx_pm === 1 ? v.d : v; });
  hook(meProto, "origin", function (v) {
    var r = rawData(this);
    if (r && r.__nx_pm === 1 && r.o) return r.o;
    return v === ORIGIN ? RU().origin : v;
  });
  hook(meProto, "source", function (v) {
    var r = rawData(this);
    if (r && r.__nx_pm === 1 && r.id) { var w = winById(r.id); if (w) return w; }
    return v;
  });

  /* ---------- ストレージの名前空間（サイト別） ---------- */
  var nsCache = null;
  function NS() {
    if (nsCache) return nsCache;
    var o = null;
    try { o = new win.URL(real()).origin; } catch (e) { o = null; }
    if (!o || o === "null") {
      try { if (win.parent !== win && win.parent.__nx_ns) return win.parent.__nx_ns(); } catch (e) { /* ignore */ }
      o = "null";
    }
    nsCache = o + "$";
    return nsCache;
  }
  try { Obj.defineProperty(win, "__nx_ns", { value: NS, configurable: true }); } catch (e) { /* ignore */ }

  function makeStorage(native) {
    var P = NS();
    function keys() {
      var out = [];
      for (var i = 0; i < native.length; i++) {
        var k = native.key(i);
        if (k !== null && k.indexOf(P) === 0) out.push(k.slice(P.length));
      }
      return out;
    }
    var api = {
      getItem: function (k) { return native.getItem(P + k); },
      setItem: function (k, v) { native.setItem(P + k, v); },
      removeItem: function (k) { native.removeItem(P + k); },
      clear: function () { keys().forEach(function (k) { native.removeItem(P + k); }); },
      key: function (i) { var r = keys()[i | 0]; return r === undefined ? null : r; }
    };
    return new Proxy(native, {
      get: function (t, k) {
        if (k === "length") return keys().length;
        if (typeof k === "symbol") return k === Symbol.toStringTag ? "Storage" : undefined;
        if (Object.prototype.hasOwnProperty.call(api, k)) return api[k];
        var v = native.getItem(P + k);
        return v === null ? undefined : v;
      },
      set: function (t, k, v) { if (typeof k === "string") native.setItem(P + k, v); return true; },
      deleteProperty: function (t, k) { if (typeof k === "string") native.removeItem(P + k); return true; },
      has: function (t, k) { return typeof k === "string" && (Object.prototype.hasOwnProperty.call(api, k) || k === "length" || native.getItem(P + k) !== null); },
      ownKeys: function () { return keys(); },
      getOwnPropertyDescriptor: function (t, k) {
        if (typeof k === "string") {
          var v = native.getItem(P + k);
          if (v !== null) return { value: v, writable: true, enumerable: true, configurable: true };
        }
        return undefined;
      }
    });
  }
  try {
    var ls = makeStorage(win.localStorage), ss = makeStorage(win.sessionStorage);
    Obj.defineProperty(win, "localStorage", { get: function () { return ls; }, configurable: true });
    Obj.defineProperty(win, "sessionStorage", { get: function () { return ss; }, configurable: true });
  } catch (e) { /* ignore */ }

  try {
    var F = win.IDBFactory.prototype;
    var idbOpen = F.open;
    F.open = function (name) { var a = Array.prototype.slice.call(arguments); a[0] = NS() + name; return idbOpen.apply(this, a); };
    var idbDel = F.deleteDatabase;
    F.deleteDatabase = function (name) { var a = Array.prototype.slice.call(arguments); a[0] = NS() + name; return idbDel.apply(this, a); };
    var idbList = F.databases;
    if (idbList) {
      F.databases = function () {
        var p = NS();
        return idbList.call(this).then(function (l) {
          return l.filter(function (x) { return x.name.indexOf(p) === 0; })
            .map(function (x) { return { name: x.name.slice(p.length), version: x.version }; });
        });
      };
    }
    hook(win.IDBDatabase.prototype, "name", function (v) { var p = NS(); return v.indexOf(p) === 0 ? v.slice(p.length) : v; });
  } catch (e) { /* ignore */ }
  try {
    var CS = win.CacheStorage.prototype;
    ["open", "has", "delete"].forEach(function (k) {
      var o = CS[k];
      CS[k] = function (name) { return o.call(this, NS() + name); };
    });
    var csKeys = CS.keys;
    CS.keys = function () {
      var p = NS();
      return csKeys.call(this).then(function (l) {
        return l.filter(function (n) { return n.indexOf(p) === 0; }).map(function (n) { return n.slice(p.length); });
      });
    };
  } catch (e) { /* ignore */ }

  /* ---------- Service Worker の登録は拒否（プロキシ自身の SW と衝突するため） ---------- */
  try {
    var SWC = win.ServiceWorkerContainer.prototype;
    SWC.register = function () { return Promise.reject(new win.DOMException("Service workers are disabled by the proxy", "SecurityError")); };
    SWC.getRegistration = function () { return Promise.resolve(undefined); };
    SWC.getRegistrations = function () { return Promise.resolve([]); };
  } catch (e) { /* ignore */ }

  /* ---------- Worker / SharedWorker（スクリプト URL をプロキシ経由に） ---------- */
  ["Worker", "SharedWorker"].forEach(function (name) {
    var C = win[name];
    if (!C) return;
    var W = function (u) {
      var a = Array.prototype.slice.call(arguments);
      a[0] = toWrapped(u);
      return Reflect.construct(C, a, new.target || W);
    };
    W.prototype = C.prototype;
    win[name] = W;
  });

  /* ---------- WebSocket（SW では拾えないので /_nx/ws 経由に差し替え） ---------- */
  var WS = win.WebSocket;
  if (WS) {
    var wsUrl = function (u) {
      try {
        var r = new win.URL(String(u), baseHref());
        if (r.protocol === "http:") r.protocol = "ws:";
        else if (r.protocol === "https:") r.protocol = "wss:";
        if (r.protocol !== "ws:" && r.protocol !== "wss:") return u;
        var realWs = r.href;
        var cookie = nxCookieString(JAR, realWs.replace(/^ws/, "http"), true);
        return ORIGIN.replace(/^http/, "ws") + "/_nx/ws?u=" + nxEncUrl(realWs) + "&o=" + nxEncUrl(RU().origin) + (cookie ? "&c=" + nxEncUrl(cookie) : "");
      } catch (e) { return u; }
    };
    var NWS = function (u, p) { var pu = wsUrl(u); return p === undefined ? new WS(pu) : new WS(pu, p); };
    NWS.prototype = WS.prototype;
    ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (k, i) { NWS[k] = i; });
    win.WebSocket = NWS;
  }

  /* ---------- リンク / フォーム / iframe（ナビゲーションはプロキシ URL にしておく必要がある） ---------- */
  function isNavAttr(tag, name) {
    if (NX_GAME_MODE && (tag === "IFRAME" || tag === "FRAME") && name === "src") return false;
    return ((tag === "A" || tag === "AREA") && name === "href") ||
      (tag === "FORM" && name === "action") ||
      ((tag === "IFRAME" || tag === "FRAME") && name === "src") ||
      ((tag === "BUTTON" || tag === "INPUT") && name === "formaction");
  }
  win.Element.prototype.setAttribute = function (n, v) {
    var l = String(n).toLowerCase();
    if (isNavAttr(this.tagName, l)) {
      var s = String(v);
      if (!((this.tagName === "IFRAME" || this.tagName === "FRAME") && s === "")) v = toWrapped(s);
    }
    return nativeSetAttr.call(this, n, v);
  };
  win.Element.prototype.getAttribute = function (n) {
    var v = nativeGetAttr.call(this, n);
    if (v !== null && isNavAttr(this.tagName, String(n).toLowerCase())) return unwrapStr(v);
    return v;
  };

  ["HTMLAnchorElement", "HTMLAreaElement"].forEach(function (cn) {
    var C = win[cn];
    if (!C) return;
    var proto = C.prototype;
    hook(proto, "href", unw, toWrapped);
    ["protocol", "host", "hostname", "port", "pathname", "origin"].forEach(function (p) {
      try {
        var o = Obj.getOwnPropertyDescriptor(proto, p);
        if (!o) return;
        Obj.defineProperty(proto, p, {
          configurable: true, enumerable: o.enumerable,
          get: function () { try { return new win.URL(this.href)[p]; } catch (e) { return ""; } },
          set: o.set ? function (v) { try { var u = new win.URL(this.href); u[p] = v; this.href = u.href; } catch (e) { /* ignore */ } } : undefined
        });
      } catch (e) { /* ignore */ }
    });
    proto.toString = function () { return this.href; };
  });
  hook(win.HTMLFormElement.prototype, "action", unw, toWrapped);
  hook(win.HTMLIFrameElement.prototype, "src", unw, function (v) { return String(v) === "" ? v : toWrapped(v); });
  if (win.HTMLFrameElement) hook(win.HTMLFrameElement.prototype, "src", unw, function (v) { return String(v) === "" ? v : toWrapped(v); });
  if (win.HTMLButtonElement) hook(win.HTMLButtonElement.prototype, "formAction", unw, toWrapped);
  if (win.HTMLInputElement) hook(win.HTMLInputElement.prototype, "formAction", unw, toWrapped);

  /* ---------- クリック直前の最終ナビゲーション保護 ----------
   * ページ側の React/Vue 等が href を後から書き換えると、MutationObserver の次の通知までに
   * 生 URL が残ることがある。クリック直前に実 URL をプロキシ URL へ戻してから既定動作を通す。
   * preventDefault は使わないので、target=_blank、修飾キー、SPA のクリック処理を壊しにくい。
   */
  try {
    doc.addEventListener("click", function (ev) {
      try {
        if (ev.defaultPrevented || ev.button !== 0) return;
        var el = ev.target;
        while (el && el.nodeType === 1 && el.tagName !== "A" && el.tagName !== "AREA") el = el.parentElement;
        if (!el) return;
        var raw = nativeGetAttr.call(el, "href");
        if (raw === null || raw === "") return;
        var shApi = shellApi();
        if (shApi && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey && !ev.altKey && nativeGetAttr.call(el, "download") === null) {
          var tg2 = String(nativeGetAttr.call(el, "target") || "").toLowerCase();
          if (tg2 === "_blank" || tg2 === "_top" || tg2 === "_parent") {
            var rr2 = resolve(unwrapStr(raw));
            if (rr2 && (rr2.protocol === "http:" || rr2.protocol === "https:")) {
              ev.preventDefault();
              if (tg2 === "_blank") shApi.openTab(rr2.href); else nloc.href = wrap(rr2.href);
              return;
            }
          }
        }
        var wrapped = toWrapped(raw);
        if (wrapped !== raw) nativeSetAttr.call(el, "href", wrapped);
      } catch (e) {}
    }, true);
    doc.addEventListener("auxclick", function (ev) {
      try {
        if (ev.button !== 1) return;
        var el = ev.target;
        while (el && el.nodeType === 1 && el.tagName !== "A" && el.tagName !== "AREA") el = el.parentElement;
        if (!el) return;
        var raw = nativeGetAttr.call(el, "href");
        if (raw === null || raw === "") return;
        var wrapped = toWrapped(raw);
        if (wrapped !== raw) nativeSetAttr.call(el, "href", wrapped);
      } catch (e) {}
    }, true);
  } catch (e) {}

  /*
   * フォームの GET 送信: ブラウザに任せると、プロキシ URL に生のクエリ（検索語など）が一瞬アドレスバーに出る。
   * 送信の時点で URL を自分で組み立て、難読化した形で移動する（POST / target 付きはそのまま）。
   */
  function formGetNav(form, submitter) {
    try {
      var attr = function (el, n) { return el ? nativeGetAttr.call(el, n) : null; };
      var method = (attr(submitter, "formmethod") || attr(form, "method") || "get").toLowerCase();
      if (method !== "get") return false;
      var target = attr(submitter, "formtarget") || attr(form, "target") || "";
      if (target && target !== "_self") return false;
      var act = attr(submitter, "formaction");
      if (act === null) act = attr(form, "action");
      var u = new win.URL(act ? unwrapStr(act) : real(), baseHref());
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
      var fd;
      try { fd = submitter ? new win.FormData(form, submitter) : new win.FormData(form); } catch (e2) { fd = new win.FormData(form); }
      var params = new win.URLSearchParams();
      fd.forEach(function (v, k) { params.append(k, typeof v === "string" ? v : v.name); });
      u.search = params.toString();
      nloc.href = wrap(u.href);
      return true;
    } catch (e) { return false; }
  }
  win.addEventListener("submit", function (e) {
    if (e.defaultPrevented) return;
    var f = e.target;
    if (f && f.tagName === "FORM" && formGetNav(f, e.submitter)) e.preventDefault();
  }, false);
  try {
    var formSubmit = win.HTMLFormElement.prototype.submit;
    win.HTMLFormElement.prototype.submit = function () { if (!formGetNav(this, null)) return formSubmit.call(this); };
  } catch (e) { /* ignore */ }

  function tryInit(w) { try { void w.document; init(w); } catch (e) { /* ignore */ } }
  hook(win.HTMLIFrameElement.prototype, "contentWindow", function (w) { if (w) tryInit(w); return w; });
  hook(win.HTMLIFrameElement.prototype, "contentDocument", function (d) { if (d && d.defaultView) tryInit(d.defaultView); return d; });

  /* ---------- スクリプト（インライン / 動的）の location 書き換え ---------- */
  function isJsScript(el) {
    var ty = (nativeGetAttr.call(el, "type") || "").trim().toLowerCase();
    return ty === "" || ty === "module" || /^(text|application)\/(x-)?(java|ecma)script$/.test(ty);
  }
  var doneScripts = new win.WeakSet();
  function fixScript(el) {
    if (doneScripts.has(el)) return;
    if (nativeGetAttr.call(el, "src") !== null || !isJsScript(el)) return;
    doneScripts.add(el);
    var out = nxRewriteJs(el.textContent);
    if (out !== null) el.textContent = out;
  }
  function scriptHook(owner, prop) {
    try {
      var d = Obj.getOwnPropertyDescriptor(owner, prop);
      if (!d || !d.set) return;
      Obj.defineProperty(win.HTMLScriptElement.prototype, prop, {
        configurable: true, enumerable: d.enumerable, get: d.get,
        set: function (v) {
          if (nativeGetAttr.call(this, "src") === null && isJsScript(this)) {
            var o = nxRewriteJs(String(v));
            if (o !== null) v = o;
          }
          d.set.call(this, v);
        }
      });
    } catch (e) { /* ignore */ }
  }
  scriptHook(win.HTMLScriptElement.prototype, "text");
  scriptHook(win.Node.prototype, "textContent");
  scriptHook(win.HTMLElement.prototype, "innerText");
  try {
    var appendChild = win.Node.prototype.appendChild;
    win.Node.prototype.appendChild = function (n) {
      if (this.tagName === "SCRIPT" && n && n.nodeType === 3 && nativeGetAttr.call(this, "src") === null && isJsScript(this)) {
        var o = nxRewriteJs(n.data);
        if (o !== null) n.data = o;
      }
      return appendChild.call(this, n);
    };
  } catch (e) { /* ignore */ }

  /* document.write で書かれたインラインスクリプトは同期実行されるので MutationObserver が間に合わない。書き込み時に直す */
  function rwWritten(h) {
    if (typeof h !== "string" || !/<script/i.test(h)) return h;
    return h.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, function (m, open, body, close) {
      if (/\bsrc\s*=/i.test(open)) return m;
      var out = nxRewriteJs(body);
      return out === null ? m : open + out + close;
    });
  }
  ["write", "writeln"].forEach(function (k) {
    var o = win.Document.prototype[k];
    win.Document.prototype[k] = function () {
      var a = Array.prototype.slice.call(arguments);
      for (var i = 0; i < a.length; i++) a[i] = rwWritten(a[i]);
      return o.apply(this, a);
    };
  });

  /* ---------- MutationObserver（HTML パーサが作った要素を直す） ---------- */
  function fixAttr(el, name) {
    var v = nativeGetAttr.call(el, name);
    if (v === null) return;
    if ((el.tagName === "IFRAME" || el.tagName === "FRAME") && v === "") return;
    // ゲームポータルの iframe は、実ゲーム本体の独立したオリジン・Service Worker・WebGL/WebRTC を
    // そのまま動かした方が互換性が高いので、親ページ（ポータル部分）だけ Nexora で動かす。
    if (NX_GAME_MODE && (el.tagName === "IFRAME" || el.tagName === "FRAME") && name === "src") return;
    var nv = toWrapped(v);
    if (nv !== v) nativeSetAttr.call(el, name, nv);
  }
  function fixMeta(el) {
    var he = (nativeGetAttr.call(el, "http-equiv") || "").toLowerCase();
    if (he === "content-security-policy" && nativeGetAttr.call(el, "data-nx") === null) { el.remove(); return; }
    if (he === "refresh") {
      var c = nativeGetAttr.call(el, "content") || "";
      var nc = c.replace(/(;\s*url\s*=\s*)(.+)$/i, function (m, p, u) { return p + toWrapped(u.trim().replace(/^['"]|['"]$/g, "")); });
      if (nc !== c) nativeSetAttr.call(el, "content", nc);
    }
  }
  function fixBase(el) {
    if (nativeGetAttr.call(el, "data-nx") !== null) return;
    var h = nativeGetAttr.call(el, "href");
    if (!h) return;
    try {
      var ours = doc.querySelector("base[data-nx]");
      if (ours) ours.href = new win.URL(h, real()).href;
    } catch (e) { /* ignore */ }
  }
  function fixHandlers(el) {
    if (!el.hasAttributes || !el.hasAttributes()) return;
    var at = el.attributes;
    if (!at) return;
    for (var i = 0; i < at.length; i++) {
      var a = at[i];
      if (a.name.indexOf("on") === 0 && a.value.indexOf("location") >= 0) {
        var o = nxRewriteJs(a.value);
        if (o !== null) nativeSetAttr.call(el, a.name, o);
      }
    }
  }
  function fixIconLink(el) {
    if (nativeGetAttr.call(el, "data-nx") !== null) return;
    var rel = (nativeGetAttr.call(el, "rel") || "").toLowerCase();
    if (/(^|\s)(icon|shortcut icon|apple-touch-icon|apple-touch-icon-precomposed|mask-icon)(\s|$)/.test(rel)) {
      try { el.remove(); } catch (e) { /* ignore */ }
    }
  }
  function fixEl(el) {
    if (el.nodeType !== 1) return;
    switch (el.tagName) {
      case "A": case "AREA": fixAttr(el, "href"); break;
      case "FORM": fixAttr(el, "action"); break;
      case "IFRAME": case "FRAME": fixAttr(el, "src"); break;
      case "BUTTON": case "INPUT": fixAttr(el, "formaction"); break;
      case "META": fixMeta(el); break;
      case "SCRIPT": fixScript(el); break;
      case "BASE": fixBase(el); break;
      case "LINK": fixIconLink(el); break;
    }
    fixHandlers(el);
  }
  var SEL = "a[href],area[href],form[action],iframe,frame,button[formaction],input[formaction],meta[http-equiv],link[rel~=\"icon\"],link[rel~=\"shortcut\"],link[rel~=\"apple-touch-icon\"],link[rel~=\"apple-touch-icon-precomposed\"],link[rel~=\"mask-icon\"],script,base,[onclick],[onload],[onerror],[onsubmit],[onchange],[onmouseover],[onmousedown],[onmouseup],[onkeydown],[onkeyup],[onfocus],[onblur],[oninput]";
  function walk(n) {
    if (n.nodeType === 1) {
      fixEl(n);
      if (n.childElementCount > 0 && n.querySelectorAll) { var l = n.querySelectorAll(SEL); for (var i = 0; i < l.length; i++) fixEl(l[i]); }
    } else if (n.nodeType === 3 && n.parentNode && n.parentNode.tagName === "SCRIPT") {
      fixScript(n.parentNode);
    }
  }
  try {
    var mo = new win.MutationObserver(function (recs) {
      for (var i = 0; i < recs.length; i++) {
        var add = recs[i].addedNodes;
        for (var j = 0; j < add.length; j++) walk(add[j]);
      }
    });
    mo.observe(doc, { childList: true, subtree: true });
    if (doc.documentElement) walk(doc.documentElement);
  } catch (e) { /* ignore */ }
  // Shadow DOM の中の a / form / iframe / script も直せるように、作られた shadow root も監視する
  try {
    var attachShadow = win.Element.prototype.attachShadow;
    win.Element.prototype.attachShadow = function (init) {
      var sr = attachShadow.call(this, init);
      try { mo.observe(sr, { childList: true, subtree: true }); } catch (e) { /* ignore */ }
      return sr;
    };
  } catch (e) { /* ignore */ }

  /* ---------- iPad focus guard: ユーザー操作を伴わない入力欄へのフォーカスを外す（以降どこをタップしてもキーボードが出る現象の防止） ---------- */
  try {
    if ((win === win.top || inShell()) && (win.navigator.maxTouchPoints || 0) > 0) {
      var lastGesture = 0;
      ["pointerdown", "touchstart", "mousedown", "keydown"].forEach(function (ev) { win.addEventListener(ev, function () { lastGesture = Date.now(); }, true); });
      doc.addEventListener("focusin", function (e) {
        var t = e.target;
        if (!t || t.nodeType !== 1) return;
        var tag = t.tagName;
        var editable = tag === "TEXTAREA" || t.isContentEditable || (tag === "INPUT" && !/^(button|submit|reset|checkbox|radio|range|color|file|image)$/i.test(t.type || "text"));
        if (!editable) return;
        var active = false;
        try { active = !!(win.navigator.userActivation && win.navigator.userActivation.isActive); } catch (x) { active = false; }
        if (active || Date.now() - lastGesture < 1500) return;
        try { t.blur(); } catch (x) { /* ignore */ }
      }, true);
    }
  } catch (e) { /* ignore */ }

  /* ---------- 描画停止の検知（タブの根フレームのみ）: JS は動いているのに描画だけ止まった / メインスレッドが詰まった、を区別する ---------- */
  try {
    if (inShell() && !LITE) {
      var wdFe = null; try { wdFe = win.frameElement; } catch (e) { wdFe = null; }
      var wdPending = false, wdProbeAt = 0, wdLastTick = performance.now(), wdLogged = 0;
      setInterval(function () {
        var now = performance.now(), tickGap = now - wdLastTick; wdLastTick = now;
        var vis = !wdFe || wdFe.classList.contains("on");
        if (!vis || doc.hidden) { wdPending = false; return; }
        var d = win.__nxDiag;
        if (tickGap > 3000 && now - wdLogged > 5000) {
          wdLogged = now;
          if (d && d.add) d.add("stall", "メインスレッドが " + Math.round(tickGap) + "ms 止まっていました(重い処理 / メモリ不足の可能性)", "", 0, 0, "");
        }
        if (wdPending) {
          if (now - wdProbeAt > 2000 && now - wdLogged > 5000) {
            wdLogged = now; wdPending = false;
            if (d && d.add) d.add("stall", "描画が " + Math.round(now - wdProbeAt) + "ms 止まっています(JS は動作中。GPU / メモリ不足の可能性)", "", 0, 0, "");
          }
        } else {
          wdPending = true; wdProbeAt = now;
          win.requestAnimationFrame(function () { wdPending = false; });
        }
      }, 1000);
    }
  } catch (e) { /* ignore */ }

  /* ---------- シェルへの報告（タブの根フレームのみ。URL バー / 内部履歴の同期用） ---------- */
  shellReport("init");
  try {
    win.addEventListener("load", function () { shellReport("title"); });
    if (inShell() && !LITE) setInterval(function () { var tt = doc.title || ""; if (tt !== __lastTitle) { __lastTitle = tt; shellReport("title"); } }, 1500);
  } catch (e) { /* ignore */ }

  /* ---------- ナビバー（最上位ページのみ） ---------- */
  try { if (win === win.top) buildBar(win, doc, nloc, barReal, RU); } catch (e) { /* ignore */ }
}

/* ---------- ナビバー ---------- */
function buildBar(win, doc, nloc, real, RU) {
  var CSS =
    ":host{all:initial}" +
    "#bar{position:fixed;left:0;right:0;bottom:0;z-index:2147483646;box-sizing:border-box;background:rgba(17,19,26,.97);border-top:1px solid #30343b;padding:6px 8px;font:13px system-ui,-apple-system,'Segoe UI',sans-serif;color:#e8eaed;box-shadow:0 -4px 20px rgba(0,0,0,.35);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}" +
    "#bar *{box-sizing:border-box}form{display:flex;gap:6px;align-items:center;margin:0}" +
    "input{flex:1;min-width:0;background:#0d0f12;border:1px solid #383e47;border-radius:8px;color:#e8eaed;padding:7px 10px;font:12px ui-monospace,Menlo,Consolas,monospace;outline:none}" +
    "input:focus{border-color:#667eea;box-shadow:0 0 0 2px rgba(102,126,234,.25)}" +
    "button{appearance:none;border:1px solid #383e47;background:#20242b;color:#d8dee9;border-radius:8px;padding:7px 10px;font:600 12px system-ui;cursor:pointer;white-space:nowrap}" +
    "button:hover{background:#2b313a}#go{background:#24406b;border-color:#3d6bab;color:#cfe3ff}#debug{border-color:rgba(133,155,255,.55);background:rgba(78,91,160,.24);color:#cbd5ff;font-size:17px;min-width:34px;padding:5px 9px;box-shadow:0 0 12px rgba(111,132,255,.12)}" +
    "#bar.min{background:none;border:0;box-shadow:none;padding:0;pointer-events:none}#bar.min form{display:none}" +
    "#open{display:none;position:fixed;left:10px;right:auto;bottom:10px;top:auto;z-index:2147483647;width:46px;height:46px;padding:0;border-radius:50%;align-items:center;justify-content:center;font-size:20px;background:rgba(102,126,234,.98);color:#fff;border:1px solid rgba(255,255,255,.65);box-shadow:0 0 0 2px rgba(102,126,234,.35),0 0 22px rgba(102,126,234,.9),0 4px 14px rgba(0,0,0,.5);touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;cursor:grab}" +
    "#open{display:inline-flex}";
  var HTML =
    '<style>' + CSS + '</style><div id="bar"><form autocomplete="off"><button id="home" type="button" title="ホーム">⌂</button>' +
    '<button id="back" type="button" title="戻る">←</button><button id="fwd" type="button" title="進む">→</button>' +
    '<input id="url" type="text" spellcheck="false"><button id="go" type="submit">移動</button>' +
    '<button id="reload" type="button" title="再読み込み">⟳</button>' +
    (NX_CFG.eruda ? '<button id="eruda" type="button" title="Eruda コンソール">🔧</button>' : "") +
    '<button id="debug" type="button" title="NEXORA Debug" aria-label="NEXORA Debug">⌁</button>' +
    '<button id="min" type="button" title="折りたたむ">✕</button></form></div><button id="open" type="button" title="バーを開く" aria-label="バーを開く">☰</button>'; 

  function isUrl(s) {
    s = (s || "").trim();
    if (!s) return false;
    var l = s.toLowerCase();
    if (l.indexOf("http://") === 0 || l.indexOf("https://") === 0) return true;
    if (/\s/.test(s)) return false;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return true;
    return /[.][a-zA-Z]{2,}/.test(s);
  }
  function save(u) {
    try {
      var h = JSON.parse(TOP_NATIVE_LS.getItem("__nx_hist") || "[]");
      h = h.filter(function (x) { return x !== u; });
      h.unshift(u);
      TOP_NATIVE_LS.setItem("__nx_hist", JSON.stringify(h.slice(0, 8)));
    } catch (e) { /* ignore */ }
  }
  function go(v) {
    var t = (v || "").trim();
    if (!t) return;
    var u;
    if (isUrl(t)) {
      var l = t.toLowerCase();
      u = l.indexOf("http://") === 0 || l.indexOf("https://") === 0 ? t : "https://" + t;
      save(u);
    } else u = NX_CFG.search + encodeURIComponent(t);
    nloc.href = wrap(u);
  }
  function mount() {
    if (doc.getElementById("__nx_host")) return;
    var host = doc.createElement("div");
    host.id = "__nx_host";
    host.setAttribute("data-nx", "");
    var root = host.attachShadow({ mode: "open" });
    root.innerHTML = HTML;
    doc.documentElement.appendChild(host);
    var $ = function (id) { return root.getElementById(id); };
    var bar = $("bar"), input = $("url");
    input.value = real();
    root.querySelector("form").addEventListener("submit", function (e) { e.preventDefault(); go(input.value); });
    $("home").addEventListener("click", function () { nloc.href = ORIGIN + NX_CFG.home; });
    $("back").addEventListener("click", function () { win.history.back(); });
    $("fwd").addEventListener("click", function () { win.history.forward(); });
    $("reload").addEventListener("click", function () { nloc.reload(); });
    $("min").addEventListener("click", function () {
      try { TOP_NATIVE_LS.setItem("__nx_min", "1"); } catch (e) { /* ignore */ }
      bar.classList.add("min"); $("open").style.display = "inline-flex";
    });
    $("open").addEventListener("click", function (e) {
      if (this.dataset.suppressOpen === "1") {
        e.preventDefault(); e.stopImmediatePropagation(); return;
      }
      try { TOP_NATIVE_LS.removeItem("__nx_min"); } catch (e) { /* ignore */ }
      bar.classList.remove("min"); this.style.display = "none";
    });
    // ≡ボタンはbarの表示状態と切り離し、window側でドラッグを追跡する。
    (function () {
      var btn = $("open"), dragging = false, moved = false;
      var startX = 0, startY = 0, baseX = 0, baseY = 0, activePointer = null;
      btn.style.display = bar.classList.contains("min") ? "inline-flex" : "none";
      function down(e) {
        if (e.button !== undefined && e.button !== 0) return;
        dragging = true; moved = false; activePointer = e.pointerId;
        startX = e.clientX; startY = e.clientY;
        var r = btn.getBoundingClientRect(); baseX = r.left; baseY = r.top;
        e.preventDefault(); e.stopPropagation();
      }
      function move(e) {
        if (!dragging || (activePointer !== null && e.pointerId !== activePointer)) return;
        var dx = e.clientX - startX, dy = e.clientY - startY;
        if (!moved && Math.hypot(dx, dy) < 8) return;
        if (!moved) {
          moved = true;
          btn.style.left = baseX + "px"; btn.style.top = baseY + "px";
          btn.style.right = "auto"; btn.style.bottom = "auto";
        }
        var x = Math.max(0, Math.min(win.innerWidth - btn.offsetWidth, baseX + dx));
        var y = Math.max(0, Math.min(win.innerHeight - btn.offsetHeight, baseY + dy));
        btn.style.left = x + "px"; btn.style.top = y + "px";
        btn.style.display = "inline-flex";
        e.preventDefault();
      }
      function up(e) {
        if (!dragging) return;
        dragging = false; activePointer = null;
        if (moved) {
          btn.dataset.suppressOpen = "1";
          btn.style.display = "inline-flex";
          setTimeout(function () { delete btn.dataset.suppressOpen; }, 650);
          e.preventDefault(); e.stopPropagation();
        }
      }
      btn.addEventListener("pointerdown", down, true);
      win.addEventListener("pointermove", move, true);
      win.addEventListener("pointerup", up, true);
      win.addEventListener("pointercancel", up, true);
      btn.addEventListener("click", function (e) {
        if (this.dataset.suppressOpen === "1") {
          e.preventDefault(); e.stopImmediatePropagation();
        }
      }, true);
      win.addEventListener("resize", function () {
        if (!btn.style.left || !btn.style.top) return;
        btn.style.left = Math.max(0, Math.min(win.innerWidth - btn.offsetWidth, parseFloat(btn.style.left) || 0)) + "px";
        btn.style.top = Math.max(0, Math.min(win.innerHeight - btn.offsetHeight, parseFloat(btn.style.top) || 0)) + "px";
      });
    })();
    var er = $("eruda");
    if (er) er.addEventListener("click", function () {
      if (win.eruda) { win.eruda.init(); return; }
      var s = doc.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/eruda";
      s.onload = function () { win.eruda.init(); };
      doc.head.appendChild(s);
    });
    var debugButton = $("debug");
    if (debugButton) debugButton.addEventListener("click", function (e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      // パネルがまだ準備できていない場合だけ pending にし、boot 完了時に開く。
      var opened = false;
      try { if (typeof win.__nxDebugToggle === "function") opened = win.__nxDebugToggle(); } catch (err) {}
      if (!opened) {
        try { win.__nxDebugPending = true; } catch (ignore) {}
        try { win.dispatchEvent(new win.Event("nx-open-debug")); } catch (ignore2) {}
      }
    }, true);
    try { if (TOP_NATIVE_LS.getItem("__nx_min") === "1") { bar.classList.add("min"); $("open").style.display = "inline-flex"; } } catch (e) { /* ignore */ }
    var sync = function () { if (root.activeElement !== input) input.value = real(); };
    win.addEventListener("popstate", sync);
    win.addEventListener("hashchange", sync);
    setInterval(sync, 700);
  }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", mount);
  else mount();
}

try { sessionStorage.removeItem("__nx_try"); } catch (e) { /* ignore */ }
init(self);
`;

/* ---- codec: URL の難読化（Worker / SW / ページ側 / ホームで共有。NX_KEY が必要） ---- */
var NX_PREFIX="/-----";
function nxBytesToB64(b){
  var t="";
  for(var i=0;i<b.length;i++)t+=String.fromCharCode(b[i]);
  return btoa(t).split("+").join("-").split("/").join("_").replace(/=+$/,"");
}
function nxB64ToBytes(s){
  var v=String(s).split("-").join("+").split("_").join("/");
  while(v.length%4)v+="=";
  var bin=atob(v),a=new Uint8Array(bin.length);
  for(var i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);
  return a;
}
function nxHash(s){
  var h=2166136261;
  for(var i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)>>>0;}
  return h>>>0;
}
function nxKeyStream(salt){
  var x=(nxHash(NX_KEY)^Math.imul(salt,0x9E3779B1))>>>0;
  if(!x)x=0x1234567;
  return function(){
    x=(x^(x<<13))>>>0;
    x=(x^(x>>>17))>>>0;
    x=(x^(x<<5))>>>0;
    return x&255;
  };
}
/* 同じ文字列は必ず同じ結果（ソルトは内容から決める）。#hash だけのリンクが「同一ページ内の移動」のまま保たれる */
function nxEncUrl(s){
  s=String(s);
  var data=new TextEncoder().encode(s);
  var salt=(nxHash(s)%255)+1;
  var ks=nxKeyStream(salt);
  var out=new Uint8Array(data.length+2),sum=0;
  out[0]=salt;
  for(var i=0;i<data.length;i++){sum=(sum+data[i])&255;out[i+2]=data[i]^ks();}
  out[1]=(sum^salt^0x5a)&255;
  return nxBytesToB64(out);
}
function nxDecUrl(t){
  try{
    var b=nxB64ToBytes(t);
    if(b.length<2||!b[0])return null;
    var salt=b[0],ks=nxKeyStream(salt),plain=new Uint8Array(b.length-2),sum=0;
    for(var i=0;i<plain.length;i++){plain[i]=b[i+2]^ks();sum=(sum+plain[i])&255;}
    if(((sum^salt^0x5a)&255)!==b[1])return null;
    return new TextDecoder().decode(plain);
  }catch(e){return null;}
}
/* 実 URL → プロキシ上の URL。origin が "" なら相対パスを返す。#hash だけは暗号化せずそのまま付ける */
function nxWrapUrl(origin,real){
  real=String(real);
  var hash="",hi=real.indexOf("#");
  if(hi>=0){hash=real.slice(hi);real=real.slice(0,hi);}
  return origin+NX_PREFIX+nxEncUrl(real)+hash;
}
/*
 * プロキシ URL の「接頭辞より後ろ」→ 実 URL（失敗したら ""）。
 * フォームの GET 送信などでブラウザが付けた生のクエリは、暗号化済みの URL の検索部分を置き換える。
 * 旧形式（/-----https://...）も読める。
 */
function nxUnwrapRest(rest){
  rest=String(rest);
  var hash="",hi=rest.indexOf("#");
  if(hi>=0){hash=rest.slice(hi);rest=rest.slice(0,hi);}
  var q="",enc=rest,qi=rest.indexOf("?");
  if(qi>=0){q=rest.slice(qi);enc=rest.slice(0,qi);}
  if(/^https?:\/\//i.test(enc))return enc+q+hash;
  var real=nxDecUrl(enc);
  if(real===null)return "";
  if(q.length>1){
    var ri=real.indexOf("?");
    if(ri>=0)real=real.slice(0,ri);
    real+=q;
  }
  return real+hash;
}
/* 書き換えモードのURL: オリジンだけ暗号化し、パスは平文のまま */
function nxRwWrap(origin,real){
  try{
    var u=new URL(String(real));
    if(u.protocol!=="http:"&&u.protocol!=="https:")return "";
    return origin+"/~/"+nxEncUrl(u.origin)+u.pathname+u.search+u.hash;
  }catch(e){return "";}
}
/* "/~/" より後ろ → 実URL(失敗したら "") */
function nxRwUnwrapRest(rest){
  rest=String(rest);
  var m=/^([A-Za-z0-9_-]+)([\s\S]*)$/.exec(rest);
  if(!m)return "";
  var o=nxDecUrl(m[1]);
  if(!o||!/^https?:\/\/[^\/]+$/i.test(o))return "";
  var tail=m[2];
  if(!tail||tail.charAt(0)==="?"||tail.charAt(0)==="#")tail="/"+tail;
  return o+tail;
}


/* ============================== ルーティング ============================== */

export default {
  async fetch(request, env, ctx) {
    ALLOW_PRIVATE = !!(env && env.NEXORA_ALLOW_PRIVATE);
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return textResponse("Bad Request", 400);
    }
    try {
      return await route(request, url, env);
    } catch (err) {
      return errorPage("内部エラー", err);
    }
  },
};

async function route(request, url, env) {
  const p = url.pathname;
  if (p === P_SW) return assetResponse(buildSwSource(), { "service-worker-allowed": "/" });
  if (p === P_HELPER) return assetResponse(buildHelperSource(), { "cache-control": "public, max-age=86400" }); // URL に ?v=バージョン が付くので長期キャッシュしてよい
  if (p === P_RWJS) return assetResponse(buildRwSource(), { "cache-control": "public, max-age=86400" });
  if (p === P_RELAY) return handleRelay(request, url);
  if (p === P_WS) return handleWebSocket(request, url, env);
  if (p === P_COMMUNITY) return handleCommunityPage(url);
  if (p === P_CHAT_WS) return handleChatWs(request, url, env);
  if (p === P_POST) return handlePost(request, url, env);
  if (p.startsWith(P_MEDIA + "/")) return handleMedia(request, url, env);
  if (p === P_HOME || p === "/") return htmlResponse(ENABLE_SHELL ? buildShell() : buildLanding());
  if (p === P_START) return htmlResponse(buildLanding({ framed: true }));
  if (p === P_LANDING) return htmlResponse(buildLanding());
  if (p.startsWith(RW_PREFIX)) return handleRewrite(request, url, env);
  if (p.startsWith(PAGE_PREFIX)) return htmlResponse(buildBootstrap());
  if (p === "/favicon.ico") return faviconResponse();
  if (p === "/apple-touch-icon.png" || p === "/apple-touch-icon-precomposed.png") return appleIconResponse();
  return textResponse("Not Found", 404);
}

function buildSwSource() {
  return '"use strict";\nconst NX_VER=' + JSON.stringify(NEXORA_VERSION) + ";\nvar NX_KEY=" + JSON.stringify(NX_KEY) + ";\nvar NX_SHELL=" + JSON.stringify(ENABLE_SHELL) + ";\nvar NX_TRANS=" + JSON.stringify(ENABLE_TRANSITION) + ";\nvar NX_GAME_HOSTS=" + JSON.stringify(GAME_COMPAT_HOSTS) + ";\nvar NX_RW_DEFAULT=" + JSON.stringify(RW_DEFAULT_HOSTS) + ";\nvar NX_DEBUG_UI=" + JSON.stringify(DEBUG_UI_HTML) + ";\n" + CODEC_SRC + "\n" + COMMON_SRC + "\n" + SW_SRC;
}

function buildRwSource() {
  return "(function(){\n\"use strict\";\nvar NX_KEY=" + JSON.stringify(NX_KEY) + ";\n" + CODEC_SRC + "\n" + RW_SRC + "\n})();";
}

function buildHelperSource() {
  const cfg = JSON.stringify({ ver: NEXORA_VERSION, eruda: ENABLE_ERUDA, search: SEARCH_BASE, prefix: PAGE_PREFIX, home: P_HOME, gameHosts: GAME_COMPAT_HOSTS });
  return "(function(){\n\"use strict\";\nvar NX_CFG=" + cfg + ";\nvar NX_KEY=" + JSON.stringify(NX_KEY) + ";\nvar NX_GAME_HOSTS=" + JSON.stringify(GAME_COMPAT_HOSTS) + ";\n" + CODEC_SRC + "\n" + COMMON_SRC + "\n" + HELPER_SRC + "\n})();";
}

function assetResponse(body, extra) {
  return new Response(body, {
    headers: Object.assign(
      { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-cache" },
      extra
    ),
  });
}

/* ============================== 中継 ( /_nx/r ) ============================== */

function relayError(status, msg) {
  return new Response(String(msg), {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-nx-error": encodeURIComponent(String(msg)).slice(0, 500),
      "cache-control": "no-store",
    },
  });
}

async function handleRelay(request, url) {
  const raw = url.searchParams.get("u");
  if (!raw) return relayError(400, "Missing URL");
  let target = nxDecUrl(raw);
  if (target === null) return relayError(400, "Invalid URL");
  for (let i = 0; i < 4; i++) {
    const selfPrefix = url.origin + PAGE_PREFIX;
    if (!target.startsWith(selfPrefix)) break;
    const inner = nxUnwrapRest(target.slice(selfPrefix.length));
    if (!inner) break;
    target = inner;
  }
  try {
    const leak = new URL(target);
    if (leak.pathname.startsWith(PAGE_PREFIX)) {
      const leakReal = nxUnwrapRest(leak.pathname.slice(PAGE_PREFIX.length) + leak.search + leak.hash);
      if (leakReal && /^https?:\/\//i.test(leakReal)) target = leakReal;
    }
  } catch { /* ignore */ }
  const u = validateTarget(target, url);
  if (!u) return relayError(400, "Invalid or unsupported URL");

  const method = request.method.toUpperCase();
  const init = { method, headers: buildUpstreamHeaders(request), redirect: "manual" };
  if (method !== "GET" && method !== "HEAD") {
    // 小さい本文はバッファして渡す（ランタイム差を避ける）。大きいものだけストリームのまま
    const len = parseInt(request.headers.get("content-length") || "-1", 10);
    if (len >= 0 && len <= 4194304) {
      init.body = await request.arrayBuffer();
    } else {
      // 長さ不明（チャンク転送のストリーミング送信など）は必ずストリームのまま渡す。
      // ここを「不明なら読み切る」にすると、ストリーミング送信中のリクエストでランタイムが
      // ハングし、SW 全体が固まる原因になる。
      init.body = request.body;
      init.duplex = "half";
    }
  }

  let upstream;
  const startedAt = Date.now();
  try {
    upstream = await fetchWithTimeout(u.href, init);
  } catch (err) {
    return relayError(502, "接続できませんでした: " + String((err && err.message) || err));
  }

  // 動画配信エラーの診断だけを追加。通常レスポンスや動画本文は変更しない。
  let diagnostic = null;
  if ((upstream.status === 403 || upstream.status === 530) &&
      /(^|\.)googlevideo\.com$/i.test(u.hostname) &&
      /\/videoplayback(?:$|\?)/i.test(u.pathname)) {
    diagnostic = await collectVideoErrorDiagnostic(upstream, request, u);
  }
  return convertResponse(upstream, method, Date.now() - startedAt, diagnostic);
}

async function collectVideoErrorDiagnostic(upstream, request, targetUrl) {
  const out = {
    host: targetUrl.hostname,
    status: upstream.status,
    contentType: upstream.headers.get("content-type") || "",
    server: upstream.headers.get("server") || "",
    cfRay: upstream.headers.get("cf-ray") || "",
    range: request.headers.has("range") ? "yes" : "no",
    ifRange: request.headers.has("if-range") ? "yes" : "no",
    body: ""
  };
  // clone() 側だけを最大1024バイト読む。実際の動画レスポンスは消費しない。
  try {
    if (upstream.body) {
      const reader = upstream.clone().body.getReader();
      const chunks = [];
      let total = 0;
      while (total < 1024) {
        const part = await reader.read();
        if (part.done) break;
        const bytes = part.value;
        const take = Math.min(bytes.length, 1024 - total);
        chunks.push(bytes.slice(0, take));
        total += take;
        if (take < bytes.length) break;
      }
      try { await reader.cancel(); } catch (e) {}
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
      out.body = new TextDecoder("utf-8").decode(merged)
        .replace(/[\r\n\t]+/g, " ")
        .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL]")
        .replace(/(signature|token|cookie|authorization|ip)=[^\s&"'<>]*/gi, "$1=[REDACTED]")
        .slice(0, 700);
    }
  } catch (e) {
    out.body = "[body preview unavailable]";
  }
  return out;
}

function buildUpstreamHeaders(request) {
  const h = new Headers();
  for (const [k, v] of request.headers) {
    if (BLOCK_REQUEST_HEADERS.test(k)) continue;
    trySet(h, k, v);
  }
  const ck = request.headers.get("x-nx-cookie");
  if (ck) trySet(h, "cookie", ck);
  const rf = request.headers.get("x-nx-referer");
  if (rf) trySet(h, "referer", rf);
  const og = request.headers.get("x-nx-origin");
  if (og) trySet(h, "origin", og);
  // SW から専用ヘッダで渡された Fetch Metadata を上流リクエストへ復元する。
  const fetchSite = request.headers.get("x-nx-fetch-site");
  if (fetchSite && /^(same-origin|same-site|cross-site|none)$/i.test(fetchSite)) {
    trySet(h, "sec-fetch-site", fetchSite);
  }
  const fetchMode = request.headers.get("x-nx-fetch-mode");
  if (fetchMode && /^[a-z-]{1,32}$/i.test(fetchMode)) {
    trySet(h, "sec-fetch-mode", fetchMode);
  }
  const fetchDest = request.headers.get("x-nx-fetch-dest");
  if (fetchDest && /^[a-z0-9-]{1,64}$/i.test(fetchDest)) {
    trySet(h, "sec-fetch-dest", fetchDest);
  }
  return h;
}

/** 上流のレスポンスを「常に 200 + x-nx-* ヘッダ」に変換して SW へ返す */
async function convertResponse(upstream, method, serverMs, diagnostic) {
  const h = new Headers();
  h.set("content-type", "application/octet-stream");
  if (diagnostic) {
    const summary = [
      "video-diagnostic",
      "host=" + diagnostic.host,
      "ct=" + diagnostic.contentType,
      "server=" + diagnostic.server,
      "cf-ray=" + diagnostic.cfRay,
      "range=" + diagnostic.range,
      "if-range=" + diagnostic.ifRange,
      "body=" + diagnostic.body
    ].join(" | ").slice(0, 1800);
    try { h.set("x-nx-diag-video", encodeURIComponent(summary).slice(0, 6000)); } catch (e) {}
  }
  h.set("x-nx-status", String(upstream.status));
  h.set("x-nx-status-text", encodeURIComponent(upstream.statusText || ""));
  h.set("vary", "x-nx-cookie");

  let ct = upstream.headers.get("content-type") || "";
  let body = null;
  const noBody = method === "HEAD" || !upstream.body || BODY_LESS_STATUS.has(upstream.status);

  if (!noBody) {
    const isHtml = /^text\/html|application\/xhtml\+xml/i.test(ct);
    const isCss = /^text\/css/i.test(ct);
    const isJs = /(application|text)\/(x-)?(java|ecma)script/i.test(ct);
    if (isHtml || isCss || isJs) {
      const hc = normalizeCharset(charsetFromHeader(ct));
      if (hc === "utf-8" || (!hc && !isHtml)) {
        body = upstream.body; // そのままストリーム
      } else {
        // UTF-8 以外（または HTML で charset 指定なし）は復号して UTF-8 にそろえる
        const bytes = new Uint8Array(await upstream.arrayBuffer());
        const cs = pickCharset(ct, bytes);
        const mime = baseMediaType(ct, isHtml ? "text/html" : isCss ? "text/css" : "text/javascript");
        ct = mime + "; charset=utf-8";
        body = cs === "utf-8" ? bytes : new TextEncoder().encode(decodeText(bytes, cs));
      }
    } else {
      body = upstream.body;
    }
  }

  for (const [k, v] of upstream.headers) {
    const name = k.toLowerCase();
    if (DROP_RESPONSE_HEADERS.test(name)) continue;
    if (name === "content-type") continue;
    try {
      h.append("x-nx-h-" + name, v);
    } catch {
      /* 不正な値は捨てる */
    }
  }
  if (ct) {
    try {
      h.set("x-nx-h-content-type", ct);
    } catch {
      /* ignore */
    }
  }

  // Set-Cookie は JS から見えないヘッダなので、番号付きの別名で SW へ渡す
  let i = 0;
  for (const sc of getSetCookieValues(upstream.headers)) {
    try {
      h.set("x-nx-sc-" + i, sc);
      i++;
    } catch {
      /* 非 ASCII などは捨てる */
    }
  }

  // ブラウザの HTTP キャッシュを活かす（バリデータは落としているので再検証はしない）
  const cc = upstream.headers.get("cache-control");
  if (cc) h.set("cache-control", cc);
  const ex = upstream.headers.get("expires");
  if (ex) h.set("expires", ex);

  h.set("x-nx-server-ms", String(Math.max(0, Number(serverMs || 0))));
  return new Response(body, { status: 200, headers: h });
}

/* ============================== WebSocket 中継 ( /_nx/ws ) ============================== */

async function handleWebSocket(request, url, env) {
  if ((request.headers.get("upgrade") || "").toLowerCase() !== "websocket") {
    return textResponse("Expected WebSocket upgrade", 426);
  }
  const raw = url.searchParams.get("u");
  if (!raw) return textResponse("Missing URL", 400);
  const real = nxDecUrl(raw);
  if (real === null) return textResponse("Invalid URL", 400);
  if (!/^wss?:\/\//i.test(real)) return textResponse("Invalid WebSocket URL", 400);

  const target = validateTarget(real.replace(/^ws/i, "http"), url);
  if (!target) return textResponse("Invalid or unsupported URL", 400);

  const headers = new Headers({ Upgrade: "websocket" });
  const proto = request.headers.get("sec-websocket-protocol");
  if (proto) headers.set("sec-websocket-protocol", proto);
  const ua = request.headers.get("user-agent");
  if (ua) trySet(headers, "user-agent", ua);
  const al = request.headers.get("accept-language");
  if (al) trySet(headers, "accept-language", al);
  const wsver = request.headers.get("sec-websocket-version");
  if (wsver) trySet(headers, "sec-websocket-version", wsver);
  const wsext = request.headers.get("sec-websocket-extensions");
  if (wsext) trySet(headers, "sec-websocket-extensions", wsext);
  const ck = url.searchParams.get("c");
  const ckv = ck ? nxDecUrl(ck) : null;
  if (ckv) trySet(headers, "cookie", ckv);
  const og = url.searchParams.get("o");
  const ogv = og ? nxDecUrl(og) : null;
  trySet(headers, "origin", ogv || target.origin);

  // 参考実装の weighted node routing を任意機能として統合。
  // ノード未設定時は余計な中継を挟まず、従来の direct relay を維持する。
  const node = nxPickWsNode(env && env[WS_NODE_ENV]);
  let upstreamUrl = target.href;
  if (node) {
    const q = new URLSearchParams();
    q.set("u", raw);
    if (og) q.set("o", og);
    if (ck) q.set("c", ck);
    upstreamUrl = new URL(node.path || P_WS, node.origin).href + "?" + q.toString();
    // ノード側のNexoraへ接続するので、target自身のOriginではなくノードOriginをOriginにする。
    trySet(headers, "origin", node.origin);
  }

  let upstream;
  try {
    upstream = await fetchWithTimeout(upstreamUrl, { headers });
  } catch (err) {
    return textResponse("WebSocket connect failed: " + String((err && err.message) || err), 502);
  }
  const upstreamWs = upstream.webSocket;
  if (!upstreamWs) {
    return textResponse("Upstream did not accept WebSocket (HTTP " + upstream.status + ")", 502);
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  upstreamWs.accept();

  const safeClose = (ws, code, reason) => {
    try { ws.close(sanitizeCloseCode(code), reason); } catch { /* ignore */ }
  };
  server.addEventListener("message", (e) => {
    try { upstreamWs.send(e.data); } catch { /* ignore */ }
  });
  upstreamWs.addEventListener("message", (e) => {
    try { server.send(e.data); } catch { /* ignore */ }
  });
  server.addEventListener("close", (e) => safeClose(upstreamWs, e.code, e.reason));
  upstreamWs.addEventListener("close", (e) => safeClose(server, e.code, e.reason));
  server.addEventListener("error", () => safeClose(upstreamWs, 1011, "error"));
  upstreamWs.addEventListener("error", () => safeClose(server, 1011, "error"));

  const respHeaders = new Headers();
  const selected = upstream.headers.get("sec-websocket-protocol");
  if (selected) respHeaders.set("sec-websocket-protocol", selected);
  const acceptedExt = upstream.headers.get("sec-websocket-extensions");
  if (acceptedExt) respHeaders.set("sec-websocket-extensions", acceptedExt);
  return new Response(null, { status: 101, webSocket: client, headers: respHeaders });
}

function nxPickWsNode(raw) {
  if (!raw) return null;
  let list;
  try { list = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
  if (!Array.isArray(list) || !list.length) return null;
  const nodes = [];
  let total = 0;
  for (const item of list) {
    try {
      const origin = new URL(String(item.origin || item.url || ""));
      if (origin.protocol !== "https:" && origin.protocol !== "http:") continue;
      if (origin.pathname !== "/") origin.pathname = origin.pathname.replace(/\/$/, "");
      const weight = Math.max(0, Number(item.weight == null ? 1 : item.weight));
      if (!weight) continue;
      nodes.push({ origin: origin.href.replace(/\/$/, ""), path: item.path || P_WS, weight });
      total += weight;
    } catch { /* invalid configured node */ }
  }
  if (!nodes.length || total <= 0) return null;
  let n = Math.random() * total;
  for (const node of nodes) { n -= node.weight; if (n < 0) return node; }
  return nodes[nodes.length - 1];
}

function sanitizeCloseCode(code) {
  const n = Number(code);
  if (n >= 1000 && n <= 4999 && n !== 1004 && n !== 1005 && n !== 1006 && n !== 1015) return n;
  return 1000;
}

/* ============================== 書き換えモード ( /~/ ) ============================== */

function rwSiteKey(host) {
  const p = String(host).toLowerCase().split(".");
  if (p.length <= 2) return p.join(".");
  const l2 = p.slice(-2).join(".");
  return /^(co|com|ne|or|ac|go|gr|ed|org|net|gov|edu)\.[a-z]{2}$/.test(l2) ? p.slice(-3).join(".") : l2;
}
function rwFetchSite(pageOrigin, targetOrigin) {
  if (pageOrigin === targetOrigin) return "same-origin";
  try {
    return rwSiteKey(new URL(pageOrigin).hostname) === rwSiteKey(new URL(targetOrigin).hostname) ? "same-site" : "cross-site";
  } catch { return "cross-site"; }
}

/* Referer(リレー上のURL)から、リクエストを出したページの実URLを取り出す */
function rwRecover(ref, relayOrigin) {
  if (!ref) return "";
  try {
    const u = new URL(ref);
    if (u.origin !== relayOrigin || !u.pathname.startsWith(RW_PREFIX)) return "";
    return nxRwUnwrapRest(u.pathname.slice(RW_PREFIX.length) + u.search) || "";
  } catch { return ""; }
}

/* ブラウザの Cookie ヘッダから、このオリジンの rw_ クッキーだけを上流用に戻す */
function rwCookieForUpstream(header) {
  if (!header) return "";
  const out = [];
  for (const part of header.split(";")) {
    const c = part.trim();
    if (c.indexOf("rw_") === 0) out.push(c.slice(3));
  }
  return out.join("; ");
}

/* 上流の Set-Cookie を、ブラウザ用(rw_ 接頭辞 + Path=/~/<seg>)に作り直す */
function rwSetCookies(headers, seg) {
  const out = [];
  for (const line of getSetCookieValues(headers)) {
    const parts = String(line).split(";");
    const first = parts.shift() || "";
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!name || /[\s;=,"\\]/.test(name)) continue;
    let httpOnly = false, maxAge = null, expires = null;
    for (const p of parts) {
      const i = p.indexOf("=");
      const k = (i < 0 ? p : p.slice(0, i)).trim().toLowerCase();
      const v = i < 0 ? "" : p.slice(i + 1).trim();
      if (k === "httponly") httpOnly = true;
      else if (k === "max-age") { const n = parseInt(v, 10); if (!isNaN(n)) maxAge = n; }
      else if (k === "expires") { const t = Date.parse(v); if (!isNaN(t)) expires = t; }
    }
    let age = null;
    if (maxAge !== null) age = Math.max(0, maxAge);
    else if (expires !== null) age = Math.max(0, Math.floor((expires - Date.now()) / 1000));
    if (age !== null) age = Math.min(age, 31536000);
    let c = "rw_" + name + "=" + value + "; Path=" + RW_PREFIX + seg + "; Secure; SameSite=Lax";
    if (httpOnly) c += "; HttpOnly";
    if (age !== null) c += "; Max-Age=" + age;
    out.push(c);
  }
  return out;
}

function rwFail(request, msg) {
  const dest = request.headers.get("sec-fetch-dest") || "";
  if (dest === "document" || dest === "iframe") return errorPage("接続できませんでした", new Error(msg));
  return textResponse(msg, 502);
}

/* HTML の属性値(相対・ルート相対・絶対)を /~/ 形式に直す。対象外なら null */
function rwAttrUrl(v, base, relayOrigin) {
  const t = String(v == null ? "" : v).trim();
  if (!t || t.charAt(0) === "#") return null;
  if (/^(javascript|data|blob|mailto|tel|about|sms|geo):/i.test(t)) return null;
  if (t.indexOf(relayOrigin + RW_PREFIX) === 0) return null;
  try {
    const abs = new URL(t, base);
    if (abs.protocol !== "http:" && abs.protocol !== "https:") return null;
    return nxRwWrap(relayOrigin, abs.href) || null;
  } catch { return null; }
}

class RwAttr {
  constructor(attr, st, origin) { this.attr = attr; this.st = st; this.origin = origin; }
  element(el) {
    const n = rwAttrUrl(el.getAttribute(this.attr), this.st.base, this.origin);
    if (n) el.setAttribute(this.attr, n);
  }
}
class RwSrcset {
  constructor(st, origin) { this.st = st; this.origin = origin; }
  element(el) {
    const val = el.getAttribute("srcset");
    if (!val) return;
    const out = val.split(",").map((part) => {
      const t = part.trim();
      const sp = t.search(/\s/);
      const u = sp === -1 ? t : t.slice(0, sp);
      const d = sp === -1 ? "" : t.slice(sp).trim();
      const n = rwAttrUrl(u, this.st.base, this.origin);
      return n ? (d ? n + " " + d : n) : t;
    }).join(", ");
    el.setAttribute("srcset", out);
  }
}
class RwBase {
  constructor(st) { this.st = st; }
  element(el) {
    const v = el.getAttribute("href");
    if (v) { try { this.st.base = new URL(v, this.st.base).href; } catch { /* ignore */ } }
    el.remove(); // 自前の <base> を head の先頭に入れるため、ページのものは消す
  }
}
class RwMeta {
  constructor(st, origin) { this.st = st; this.origin = origin; }
  element(el) {
    const he = (el.getAttribute("http-equiv") || "").toLowerCase();
    if (he === "content-security-policy" || he === "content-security-policy-report-only") { el.remove(); return; }
    if (he === "refresh") {
      const c = el.getAttribute("content") || "";
      const m = c.match(/^(\s*[\d.]*\s*;\s*url\s*=\s*)(.+)$/i);
      if (m) {
        const n = rwAttrUrl(m[2].trim().replace(/^['"]|['"]$/g, ""), this.st.base, this.origin);
        if (n) el.setAttribute("content", m[1] + n);
      }
    }
  }
}
class RwHead {
  constructor(html) { this.html = html; }
  element(el) { el.prepend(this.html, { html: true }); }
}

async function handleRewrite(request, url, env) {
  const restPath = url.pathname.slice(RW_PREFIX.length);
  const real = nxRwUnwrapRest(restPath + url.search);
  if (!real) return textResponse("Invalid address", 400);
  const target = validateTarget(real, url);
  if (!target) return textResponse("Invalid or unsupported URL", 400);
  const seg = restPath.split("/")[0];
  const method = request.method.toUpperCase();

  // ---- 上流へ送るヘッダ ----
  const refReal = rwRecover(request.headers.get("referer"), url.origin);
  let pageOrigin = target.origin;
  if (refReal) { try { pageOrigin = new URL(refReal).origin; } catch { /* ignore */ } }
  const h = new Headers();
  for (const [k, v] of request.headers) {
    if (BLOCK_REQUEST_HEADERS.test(k)) continue;
    trySet(h, k, v);
  }
  trySet(h, "referer", refReal || target.origin + "/");
  if (request.headers.get("origin")) trySet(h, "origin", pageOrigin);
  const sfs = request.headers.get("sec-fetch-site");
  if (sfs) trySet(h, "sec-fetch-site", sfs === "none" ? "none" : rwFetchSite(pageOrigin, target.origin));
  const sfm = request.headers.get("sec-fetch-mode");
  if (sfm && /^[a-z-]{1,32}$/i.test(sfm)) trySet(h, "sec-fetch-mode", sfm);
  const sfd = request.headers.get("sec-fetch-dest");
  if (sfd && /^[a-z0-9-]{1,64}$/i.test(sfd)) trySet(h, "sec-fetch-dest", sfd);
  const ck = rwCookieForUpstream(request.headers.get("cookie"));
  if (ck) trySet(h, "cookie", ck);

  const init = { method, headers: h, redirect: "manual" };
  if (method !== "GET" && method !== "HEAD") {
    const len = parseInt(request.headers.get("content-length") || "-1", 10);
    if (len >= 0 && len <= 4194304) {
      init.body = await request.arrayBuffer();
    } else {
      init.body = request.body;
      init.duplex = "half";
    }
  }

  let upstream;
  try {
    upstream = await fetchWithTimeout(target.href, init);
  } catch (err) {
    return rwFail(request, "接続できませんでした: " + String((err && err.message) || err));
  }

  const status = upstream.status;
  const cookies = rwSetCookies(upstream.headers, seg);

  // ---- リダイレクト: /~/ 形式のまま辿らせる ----
  const loc = upstream.headers.get("location");
  if (status >= 300 && status < 400 && loc) {
    let dest = "";
    try { dest = nxRwWrap(url.origin, new URL(loc, target.href).href); } catch { dest = ""; }
    if (dest) {
      const rh = new Headers({ location: dest, "cache-control": "no-store" });
      for (const c of cookies) rh.append("set-cookie", c);
      return new Response(null, { status, headers: rh });
    }
  }

  // ---- 応答ヘッダ(ほぼ素通し) ----
  const rh = new Headers(upstream.headers);
  for (const k of Array.from(rh.keys())) if (RW_UNSAFE_RESPONSE.test(k)) rh.delete(k);
  for (const c of cookies) rh.append("set-cookie", c);

  if (method === "HEAD" || !upstream.body || BODY_LESS_STATUS.has(status)) {
    return new Response(null, { status, statusText: upstream.statusText, headers: rh });
  }

  const ct = upstream.headers.get("content-type") || "";
  const attach = /^\s*attachment/i.test(upstream.headers.get("content-disposition") || "");
  const isHtml = /^text\/html|application\/xhtml\+xml/i.test(ct) && !attach;
  if (!isHtml) {
    return new Response(upstream.body, { status, statusText: upstream.statusText, headers: rh });
  }

  // ---- HTML: 属性を書き換え、<base> と注入スクリプトを差し込む ----
  const st = { base: target.href };
  const baseHref = nxRwWrap(url.origin, target.href.split("#")[0]);
  const cfg = JSON.stringify({ u: target.href, s: seg }).replace(/</g, "\\u003c");
  const inject =
    '<base href="' + escapeHtml(baseHref) + '"><script>window.__nxRw=' + cfg + ";</script>" +
    '<script src="' + P_RWJS + "?v=" + NEXORA_VERSION + '"></script>';
  const A = (sel, attr) => [sel, new RwAttr(attr, st, url.origin)];
  const pairs = [
    ["base[href]", new RwBase(st)],
    ["meta[http-equiv]", new RwMeta(st, url.origin)],
    A("a[href]", "href"), A("area[href]", "href"), A("link[href]", "href"),
    A("script[src]", "src"), A("img[src]", "src"), A("iframe[src]", "src"), A("frame[src]", "src"),
    A("video[src]", "src"), A("video[poster]", "poster"), A("audio[src]", "src"),
    A("source[src]", "src"), A("track[src]", "src"), A("embed[src]", "src"), A("input[src]", "src"),
    A("object[data]", "data"), A("form[action]", "action"),
    A("button[formaction]", "formaction"), A("input[formaction]", "formaction"),
    ["img[srcset]", new RwSrcset(st, url.origin)], ["source[srcset]", new RwSrcset(st, url.origin)],
    ["head", new RwHead(inject)],
  ];
  let rewriter = new HTMLRewriter();
  for (const [sel, handler] of pairs) rewriter = rewriter.on(sel, handler);

  rh.delete("content-length");
  rh.delete("content-encoding");
  rh.delete("etag");
  rh.delete("last-modified");
  const cs = /charset\s*=\s*"?([^;"\s]+)/i.exec(ct);
  rh.set("content-type", cs ? "text/html; charset=" + cs[1] : "text/html");
  rh.set("cache-control", "private, no-cache");
  return rewriter.transform(new Response(upstream.body, { status, statusText: upstream.statusText, headers: rh }));
}

/* ============================== コミュニティ(共有チャット + 投稿) ============================== */

function chatJson(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function chatSameOrigin(request, url) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try { return new URL(origin).host === url.host; } catch { return false; }
}

function handleCommunityPage(url) {
  // ハブ以外の Worker から開かれたら、ハブへ送る
  if (url.origin !== COMMUNITY_HUB) {
    return new Response(null, {
      status: 302,
      headers: { location: COMMUNITY_HUB + P_COMMUNITY, "cache-control": "no-store" },
    });
  }
  return htmlResponse(COMMUNITY_HTML);
}

function handleChatWs(request, url, env) {
  if (!env || !env.CHAT_ROOM) return textResponse("Chat is not enabled on this Worker", 501);
  if ((request.headers.get("upgrade") || "").toLowerCase() !== "websocket") {
    return textResponse("Expected WebSocket", 426);
  }
  if (!chatSameOrigin(request, url)) return textResponse("Forbidden", 403);
  const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName("main"));
  return stub.fetch(request);
}

/* 投稿: POST /_nx/post
 *   ヘッダ x-chat-name / x-chat-pass / x-post-text / x-file-name は encodeURIComponent したもの
 *   本文 = ファイルそのもの(無ければ空)。Content-Type = ファイルの MIME */
async function handlePost(request, url, env) {
  if (request.method !== "POST") return textResponse("Method Not Allowed", 405);
  if (!env || !env.CHAT_ROOM) return textResponse("Chat is not enabled on this Worker", 501);
  if (!chatSameOrigin(request, url)) return textResponse("Forbidden", 403);

  const dec = (v) => { try { return decodeURIComponent(v || ""); } catch { return ""; } };
  const name = dec(request.headers.get("x-chat-name"));
  const pass = dec(request.headers.get("x-chat-pass"));
  const text = dec(request.headers.get("x-post-text")).trim().slice(0, CHAT_POST_TEXT);
  const fileName = dec(request.headers.get("x-file-name")).replace(/[\u0000-\u001F\u007F]/g, "").slice(0, 100);

  const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName("main"));
  const v = await stub.verify(name, pass, true);
  if (!v.ok) return chatJson({ error: v.error }, v.status || 401);

  const ctype = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const len = parseInt(request.headers.get("content-length") || "0", 10);

  if (len > 0) {
    const info = CHAT_MEDIA_TYPES[ctype];
    if (!info) return chatJson({ error: "対応していないファイル形式です(画像: jpg/png/gif/webp、音声: mp3/m4a/ogg/wav、動画: mp4/webm/mov)" }, 415);
    if (len > info.max) return chatJson({ error: "ファイルが大きすぎます(上限 " + Math.round(info.max / MB) + "MB)" }, 413);
    const key = crypto.randomUUID() + info.ext;
    const q = new URLSearchParams({
      key, type: ctype, kind: info.kind, max: String(info.max),
      name: v.name, uid: v.uid, text, fname: fileName,
    });
    // ファイルは Durable Object へそのまま流し込む(保存と投稿の登録は DO の中で行う)
    const res = await stub.fetch("https://chatroom/_upload?" + q.toString(), { method: "POST", body: request.body });
    return new Response(res.body, {
      status: res.status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }

  if (!text) return chatJson({ error: "本文かファイルを入れてください" }, 400);
  try {
    await stub.addPost({ name: v.name, uid: v.uid, text, media: null });
  } catch {
    return chatJson({ error: "投稿を保存できませんでした" }, 500);
  }
  return chatJson({ ok: true });
}

/* ファイル配信: GET /_nx/media/<key>(中身は DO が返す。Range 対応 = iPhone / Safari の動画・音声の再生に必要) */
async function handleMedia(request, url, env) {
  if (!env || !env.CHAT_ROOM) return textResponse("Media is not enabled on this Worker", 501);
  if (request.method !== "GET" && request.method !== "HEAD") return textResponse("Method Not Allowed", 405);
  let key = "";
  try { key = decodeURIComponent(url.pathname.slice(P_MEDIA.length + 1)); } catch { /* ignore */ }
  if (!/^[0-9a-f-]{36}\.[a-z0-9]{2,5}$/.test(key)) return textResponse("Not Found", 404);
  const headers = new Headers();
  const rg = request.headers.get("range");
  if (rg) headers.set("range", rg);
  const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName("main"));
  return stub.fetch("https://chatroom/_media/" + key, { method: request.method, headers });
}

/* ---- 名前の正規化・合言葉のハッシュ ---- */
function chatNormName(s) {
  return String(s || "").normalize("NFKC").replace(/[\s\u200B-\u200F\u2060\uFEFF]/g, "").toLowerCase();
}
function chatCleanName(s) {
  return String(s || "").normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u2028\u2029\u2060\uFEFF]/g, "")
    .replace(/\s+/g, " ").trim();
}
async function chatHash(salt, pass) {
  const d = new TextEncoder().encode(salt + ":" + pass);
  const h = await crypto.subtle.digest("SHA-256", d);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function chatEq(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS blobs (key TEXT NOT NULL, i INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (key, i))");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS media (key TEXT PRIMARY KEY, mime TEXT NOT NULL, size INTEGER NOT NULL)");
  }

  /* ---------- ログイン(名前 + 合言葉)。初めての名前はそのまま登録される ---------- */
  async login(rawName, rawPass) {
    const name = chatCleanName(rawName), key = chatNormName(name);
    if (!name || !key) return { ok:false, error:"名前を入力してください" };
    if ([...name].length > CHAT_MAX_NAME) return { ok:false, error:"名前は" + CHAT_MAX_NAME + "文字までです" };
    const pass = String(rawPass || "");
    if (pass.length < 10 || pass.length > 64) return { ok:false, error:"合言葉は10〜64文字で入力してください" };
    const now = Date.now(), fk = "f:" + key;
    const f = (await this.ctx.storage.get(fk)) || { n:0, t:0 };
    if (now - f.t > CHAT_FAIL_WINDOW_MS) f.n = 0;
    if (f.n >= CHAT_FAIL_MAX) return { ok:false, error:"失敗が続いたため、しばらく待ってからやり直してください", status:429 };
    const fail = async () => { f.n++; f.t=now; await this.ctx.storage.put(fk,f); return { ok:false, error:"その名前は使われています(合言葉が違います)" }; };
    const adminKey = this.env.CHAT_ADMIN_NAME ? chatNormName(this.env.CHAT_ADMIN_NAME) : "";
    if (adminKey && key === adminKey) {
      const ap = String(this.env.CHAT_ADMIN_PASS || "");
      if (!ap || !chatEq(pass, ap)) return fail();
      if (f.n) await this.ctx.storage.delete(fk);
      return { ok:true, name, uid:"admin", admin:true };
    }
    const uk = "u:" + key;
    const fresh = { name, uid:crypto.randomUUID(), salt:crypto.randomUUID(), hash:"", last:now };
    fresh.hash = await chatHash(fresh.salt, pass);
    const outcome = await this.ctx.storage.transaction(async (txn) => {
      const rec = await txn.get(uk);
      if (!rec || now - rec.last > CHAT_NAME_TTL_MS) {
        await txn.put(uk, fresh);
        return { ok:true, name, uid:fresh.uid, created:true };
      }
      const h = await chatHash(rec.salt, pass);
      if (!chatEq(h, rec.hash)) return { ok:false };
      rec.last = now; rec.name = name;
      if (!rec.uid) rec.uid = crypto.randomUUID();
      await txn.put(uk, rec);
      return { ok:true, name, uid:rec.uid };
    });
    if (!outcome.ok) return fail();
    if (f.n) await this.ctx.storage.delete(fk);
    return outcome;
  }

  async verify(name, pass, forPost) {
    const r = await this.login(name, pass);
    if (!r.ok) return { ok:false, error:r.error, status:r.status };
    if (forPost) {
      const lk = "lp:" + r.uid, now = Date.now();
      const last = (await this.ctx.storage.get(lk)) || 0;
      if (now - last < CHAT_POST_INTERVAL_MS) return { ok:false, error:"投稿が早すぎます。少し待ってください", status:429 };
      await this.ctx.storage.put(lk, now);
    }
    return { ok:true, name:r.name, uid:r.uid, admin:!!r.admin };
  }

  async addPost(p) {
    const post = { id:crypto.randomUUID(), name:p.name, uid:p.uid || "", text:p.text || "", media:p.media || null, ts:Date.now() };
    const posts = (await this.ctx.storage.get("posts")) || [];
    posts.push(post);
    while (posts.length > CHAT_MAX_POSTS) {
      const old = posts.shift();
      if (old && old.media) this.deleteMedia(old.media.key);
    }
    await this.ctx.storage.put("posts", posts);
    this.broadcast({ type:"post", post });
    return post.id;
  }

  /* ---------- ファイルの保存(R2 の代わりに、DO の SQLite へ 1MiB ずつ分けて保存) ---------- */
  deleteMedia(key) {
    try {
      this.ctx.storage.sql.exec("DELETE FROM blobs WHERE key = ?", key);
      this.ctx.storage.sql.exec("DELETE FROM media WHERE key = ?", key);
    } catch { /* ignore */ }
  }

  async handleUpload(request) {
    const q = new URL(request.url).searchParams;
    const key = q.get("key") || "";
    const ctype = q.get("type") || "";
    const max = Number(q.get("max")) || 0;
    if (!/^[0-9a-f-]{36}\.[a-z0-9]{2,5}$/.test(key) || !request.body) return chatJson({ error: "bad request" }, 400);

    const sql = this.ctx.storage.sql;
    const reader = request.body.getReader();
    const buf = new Uint8Array(CHAT_CHUNK);
    let fill = 0, idx = 0, total = 0;
    const flush = () => {
      sql.exec("INSERT INTO blobs (key, i, data) VALUES (?, ?, ?)", key, idx++, buf.slice(0, fill).buffer);
      fill = 0;
    };
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        const v = r.value;
        total += v.length;
        if (total > max) throw new Error("too big");
        let off = 0;
        while (off < v.length) {
          const n = Math.min(v.length - off, CHAT_CHUNK - fill);
          buf.set(v.subarray(off, off + n), fill);
          fill += n; off += n;
          if (fill === CHAT_CHUNK) flush();
        }
      }
      if (fill) flush();
      sql.exec("INSERT INTO media (key, mime, size) VALUES (?, ?, ?)", key, ctype, total);
    } catch (err) {
      this.deleteMedia(key);
      const big = String(err && err.message) === "too big";
      return chatJson({ error: big ? "ファイルが大きすぎます" : "ファイルを保存できませんでした" }, big ? 413 : 500);
    }
    const media = { key, kind: q.get("kind") || "", mime: ctype, size: total, name: q.get("fname") || "" };
    await this.addPost({ name: q.get("name") || "", uid: q.get("uid") || "", text: q.get("text") || "", media });
    return chatJson({ ok: true });
  }

  handleMediaGet(request) {
    const key = new URL(request.url).pathname.slice("/_media/".length);
    const sql = this.ctx.storage.sql;
    const row = sql.exec("SELECT mime, size FROM media WHERE key = ?", key).toArray()[0];
    if (!row) return new Response("Not Found", { status: 404 });
    const size = row.size;
    const h = new Headers({
      "content-type": row.mime,
      "accept-ranges": "bytes",
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
    });
    let start = 0, end = size - 1, status = 200;
    const rg = request.headers.get("range");
    if (rg) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(rg.trim());
      if (m && (m[1] !== "" || m[2] !== "")) {
        if (m[1] === "") start = Math.max(0, size - Number(m[2]));
        else { start = Number(m[1]); if (m[2] !== "") end = Math.min(end, Number(m[2])); }
        if (start > end || start >= size) {
          return new Response(null, { status: 416, headers: { "content-range": "bytes */" + size } });
        }
        status = 206;
        h.set("content-range", "bytes " + start + "-" + end + "/" + size);
      }
    }
    h.set("content-length", String(end - start + 1));
    if (request.method === "HEAD") return new Response(null, { status, headers: h });

    let pos = start;
    const body = new ReadableStream({
      pull(controller) {
        if (pos > end) { controller.close(); return; }
        const i = Math.floor(pos / CHAT_CHUNK);
        const r = sql.exec("SELECT data FROM blobs WHERE key = ? AND i = ?", key, i).toArray()[0];
        if (!r) { controller.error(new Error("missing chunk")); return; }
        const data = new Uint8Array(r.data);
        const from = pos - i * CHAT_CHUNK;
        const to = Math.min(data.length, end - i * CHAT_CHUNK + 1);
        controller.enqueue(data.slice(from, to));
        pos = i * CHAT_CHUNK + to;
      },
    });
    return new Response(body, { status, headers: h });
  }

  /* ---------- WebSocket / 内部ルート ---------- */
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/_upload") return this.handleUpload(request);
    if (path.startsWith("/_media/")) return this.handleMediaGet(request);
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernation API: 誰も話していない間は DO が眠れるので無料枠に優しい
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ times: [], name: "", uid: "", admin: false });

    const history = (await this.ctx.storage.get("history")) || [];
    const posts = (await this.ctx.storage.get("posts")) || [];
    server.send(JSON.stringify({ type: "init", history, posts, online: this.ctx.getWebSockets().length }));
    this.broadcastOnline();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 4000) return;
    let d;
    try { d = JSON.parse(raw); } catch { return; }
    if (!d || typeof d !== "object") return;
    const att = ws.deserializeAttachment() || { times: [], name: "", uid: "", admin: false };
    const reply = (o) => { try { ws.send(JSON.stringify(o)); } catch { /* ignore */ } };

    if (d.type === "login") {
      const r = await this.login(d.name, d.pass);
      if (!r.ok) { reply({ type: "login_error", text: r.error }); return; }
      ws.serializeAttachment({ times: att.times || [], name: r.name, uid: r.uid, admin: !!r.admin });
      reply({ type: "login_ok", name: r.name, uid: r.uid, admin: !!r.admin, created: !!r.created });
      return;
    }
    if (d.type === "logout") {
      ws.serializeAttachment({ times: att.times || [], name: "", uid: "", admin: false });
      return;
    }
    if (!att.name) { reply({ type: "error", text: "先に名前を決めてください" }); return; }

    if (d.type === "msg") {
      const text = String(d.text || "").trim().slice(0, CHAT_MAX_TEXT);
      if (!text) return;
      const now = Date.now();
      const times = (att.times || []).filter((t) => now - t < CHAT_RATE_WINDOW_MS);
      if (times.length >= CHAT_RATE_COUNT) {
        reply({ type: "error", text: "送信が早すぎます。少し待ってください" });
        return;
      }
      times.push(now);
      ws.serializeAttachment({ times, name: att.name, uid: att.uid, admin: att.admin });

      const msg = { id: crypto.randomUUID(), name: att.name, text, ts: now };
      const history = (await this.ctx.storage.get("history")) || [];
      history.push(msg);
      if (history.length > CHAT_MAX_HISTORY) history.splice(0, history.length - CHAT_MAX_HISTORY);
      await this.ctx.storage.put("history", history);
      this.broadcast({ type: "msg", msg });
      return;
    }

    if (d.type === "delmsg") {
      if (!att.admin) return;
      const id = String(d.id || "");
      const history = (await this.ctx.storage.get("history")) || [];
      const next = history.filter((m) => m.id !== id);
      if (next.length === history.length) return;
      await this.ctx.storage.put("history", next);
      this.broadcast({ type: "delmsg", id });
      return;
    }

    if (d.type === "delpost") {
      const id = String(d.id || "");
      const posts = (await this.ctx.storage.get("posts")) || [];
      const p = posts.find((x) => x.id === id);
      if (!p) return;
      if (!att.admin && p.uid !== att.uid) return;
      await this.ctx.storage.put("posts", posts.filter((x) => x.id !== id));
      if (p.media) this.deleteMedia(p.media.key);
      this.broadcast({ type: "delpost", id });
    }
  }

  webSocketClose(ws) {
    try { ws.close(1000, "bye"); } catch { /* ignore */ }
    this.broadcastOnline(ws);
  }

  webSocketError(ws) {
    this.broadcastOnline(ws);
  }

  broadcast(obj, exclude) {
    const out = JSON.stringify(obj);
    for (const s of this.ctx.getWebSockets()) {
      if (s === exclude) continue;
      try { s.send(out); } catch { /* 切れた接続は無視 */ }
    }
  }

  broadcastOnline(exclude) {
    const n = this.ctx.getWebSockets().filter((s) => s !== exclude).length;
    this.broadcast({ type: "online", online: n }, exclude);
  }
}

/* ---- 画面 ----
 * 注意: この中は JS のテンプレート文字列。バッククォート・ドル+波括弧・バックスラッシュを書かないこと */
const COMMUNITY_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>コミュニティ</title>
<style>
:root{--bg:#121726;--panel:#1b2238;--line:#2a3350;--txt:#e9ecf5;--dim:#8d96b3;--acc:#6cb4ff;--mine:#26487a;--bad:#ff9b9b}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{background:var(--bg);color:var(--txt);font:15px/1.5 system-ui,-apple-system,"Hiragino Sans","Segoe UI",sans-serif;display:flex;flex-direction:column;height:100dvh;overflow:hidden}
header{flex:none;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;background:var(--panel)}
header h1{font-size:16px;font-weight:700}
#hr{display:flex;align-items:center;gap:10px;min-width:0}
#status{display:flex;align-items:center;gap:6px;color:var(--dim);font-size:12px;white-space:nowrap}
#dot{width:8px;height:8px;border-radius:50%;background:#e0a24a;transition:background .3s}
#dot.on{background:#5fd08a}
button{flex:none;appearance:none;border:0;border-radius:12px;padding:0 18px;height:42px;font:inherit;font-weight:700;color:#0c1426;background:var(--acc);cursor:pointer;transition:transform .12s,opacity .15s}
button:active{transform:scale(.95)}
button:disabled{opacity:.4;cursor:default}
button.ghost{height:34px;padding:0 12px;font-size:13px;font-weight:600;color:var(--txt);background:rgba(255,255,255,.08);border:1px solid var(--line);max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
nav{flex:none;display:flex;background:var(--panel);border-bottom:1px solid var(--line)}
nav button.tab{flex:1;height:42px;border-radius:0;background:none;color:var(--dim);border-bottom:2px solid transparent}
nav button.tab.on{color:var(--txt);border-bottom-color:var(--acc)}
.pane{display:none;flex:1;min-height:0;flex-direction:column}
.pane.on{display:flex}
.scroll{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
#list{padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.empty{margin:auto;color:var(--dim);text-align:center;padding:30px 0}
.m{max-width:min(82%,560px);align-self:flex-start}
.m .meta{display:flex;gap:8px;align-items:baseline;margin:0 4px 3px;font-size:12px;color:var(--dim)}
.m .meta b{color:var(--txt);font-weight:600;font-size:13px}
.m .body{background:var(--panel);border:1px solid var(--line);border-radius:4px 16px 16px 16px;padding:8px 12px;white-space:pre-wrap;overflow-wrap:anywhere}
.m.own{align-self:flex-end}
.m.own .meta{justify-content:flex-end}
.m.own .body{background:var(--mine);border-color:#34609c;border-radius:16px 4px 16px 16px}
.del{display:none;height:auto;padding:0 6px;font-size:11px;font-weight:600;color:var(--bad);background:none;border:0}
body.adm .del,.card.own .del{display:inline-block}
.err{flex:none;color:var(--bad);font-size:13px}
.err:not(:empty){padding:6px 16px}
.bar{flex:none;padding:10px 12px calc(10px + env(safe-area-inset-bottom,0px));background:var(--panel);border-top:1px solid var(--line)}
.row{display:flex;gap:8px;align-items:flex-end}
input,textarea{font:inherit;font-size:16px;color:var(--txt);background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:10px 12px;outline:none;min-width:0;width:100%}
input:focus,textarea:focus{border-color:var(--acc);box-shadow:0 0 0 3px rgba(108,180,255,.18)}
textarea{resize:none;height:44px;max-height:120px}
#feedwrap{padding:12px 14px}
#composer{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:12px;display:flex;flex-direction:column;gap:10px;margin-bottom:14px}
#composer .row{align-items:center}
#fname{flex:1;font-size:12px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
progress{width:100%;height:6px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:12px;margin-bottom:12px}
.card .meta{display:flex;gap:8px;align-items:baseline;font-size:12px;color:var(--dim);margin-bottom:6px}
.card .meta b{color:var(--txt);font-size:14px}
.card .meta .del{margin-left:auto}
.card .text{white-space:pre-wrap;overflow-wrap:anywhere;margin-bottom:8px}
.media{display:block;width:100%;border-radius:12px;background:#000}
img.media{max-height:70vh;object-fit:contain}
video.media{max-height:70vh}
audio.media{height:44px;background:none}
.cap{font-size:11px;color:var(--dim);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#dlg{position:fixed;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(5,8,18,.7)}
#dlg[hidden]{display:none}
#dbox{width:min(92vw,380px);background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:18px;display:flex;flex-direction:column;gap:10px}
#dbox h2{font-size:16px}
#dbox p{font-size:12px;color:var(--dim)}
#derr{font-size:13px;color:var(--bad);min-height:0}
#dbox .row{justify-content:flex-end}
#dbox button.sub{background:rgba(255,255,255,.08);color:var(--txt);border:1px solid var(--line)}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
</head>
<body>
<header>
  <h1>コミュニティ</h1>
  <div id="hr"><span id="status"><span id="dot"></span><span id="stext">接続中…</span></span><button id="who" type="button" class="ghost">ログイン</button></div>
</header>
<nav><button class="tab on" type="button" data-t="chat">チャット</button><button class="tab" type="button" data-t="posts">投稿</button></nav>

<section id="p-chat" class="pane on">
  <div id="list" class="scroll"><p class="empty">まだ誰もいません。</p></div>
  <div id="err" class="err"></div>
  <form id="form" class="bar" autocomplete="off">
    <div class="row">
      <textarea id="text" maxlength="500" rows="1" placeholder="メッセージ(Enterで送信 / Shift+Enterで改行)" aria-label="メッセージ"></textarea>
      <button id="send" type="submit" disabled>送信</button>
    </div>
  </form>
</section>

<section id="p-posts" class="pane">
  <div id="feedwrap" class="scroll">
    <div id="composer">
      <textarea id="ptext" maxlength="500" rows="2" placeholder="ひとこと(省略できます)" aria-label="投稿の本文" style="height:64px"></textarea>
      <div class="row">
        <button id="pick" type="button" class="ghost">ファイルを選ぶ</button>
        <span id="fname">画像 / 音声 / 動画</span>
        <button id="pclear" type="button" class="ghost" hidden>外す</button>
      </div>
      <input id="pfile" type="file" hidden accept="image/jpeg,image/png,image/gif,image/webp,audio/*,video/mp4,video/webm,video/quicktime,.mp3,.m4a,.mp4,.mov,.webm,.ogg,.wav,.aac">
      <progress id="pprog" max="100" value="0" hidden></progress>
      <div id="perr" class="err"></div>
      <div class="row" style="justify-content:flex-end"><button id="pgo" type="button">投稿する</button></div>
    </div>
    <div id="feed"><p class="empty">まだ投稿がありません。</p></div>
  </div>
</section>

<div id="dlg" hidden>
  <form id="dbox" autocomplete="off">
    <h2>ログイン / 名前を決める</h2>
    <p>初めての名前はそのまま登録されます。同じ名前で入るには同じ合言葉が要ります。</p>
    <input id="dname" type="text" maxlength="20" placeholder="名前(20文字まで)" aria-label="名前">
    <input id="dpass" type="password" maxlength="64" placeholder="合言葉(10文字以上)" aria-label="合言葉">
    <div id="derr"></div>
    <div class="row">
      <button id="dout" type="button" class="sub" hidden>ログアウト</button>
      <button id="dcancel" type="button" class="sub">閉じる</button>
      <button id="dok" type="submit">決定</button>
    </div>
  </form>
</div>

<script>
(function(){
  var $=function(id){return document.getElementById(id)};
  var list=$("list"),feed=$("feed"),dot=$("dot"),stext=$("stext"),err=$("err"),perr=$("perr");
  var textIn=$("text"),sendBtn=$("send"),who=$("who");
  var ws=null,retry=0,online=0,connected=false,me=null,creds=null,pending=null,loginAuto=false,errTimer=0,file=null,uploading=false;
  var KIND={"image/jpeg":"image","image/png":"image","image/gif":"image","image/webp":"image","audio/mpeg":"audio","audio/mp4":"audio","audio/aac":"audio","audio/ogg":"audio","audio/wav":"audio","audio/webm":"audio","video/mp4":"video","video/webm":"video","video/quicktime":"video"};
  var EXT={jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",gif:"image/gif",webp:"image/webp",mp3:"audio/mpeg",m4a:"audio/mp4",aac:"audio/aac",ogg:"audio/ogg",wav:"audio/wav",weba:"audio/webm",mp4:"video/mp4",webm:"video/webm",mov:"video/quicktime"};
  var LIM={image:5,audio:15,video:30};

  function loadCreds(){var s=["localStorage","sessionStorage"];for(var i=0;i<s.length;i++){try{var v=JSON.parse(window[s[i]].getItem("c_creds")||"null");if(v&&v.name&&v.pass)return v}catch(e){}}return null}
  function saveCreds(c){try{localStorage.setItem("c_creds",JSON.stringify(c))}catch(e){try{sessionStorage.setItem("c_creds",JSON.stringify(c))}catch(x){}}}
  function clearCreds(){try{localStorage.removeItem("c_creds")}catch(e){}try{sessionStorage.removeItem("c_creds")}catch(e){}}
  creds=loadCreds();

  function pad(n){return n<10?"0"+n:""+n}
  function fmt(ts,full){var d=new Date(ts),t=pad(d.getHours())+":"+pad(d.getMinutes());return full?((d.getMonth()+1)+"/"+d.getDate()+" "+t):t}
  function nearBottom(){return list.scrollHeight-list.scrollTop-list.clientHeight<80}
  function showErr(el,t){el.textContent=t;if(el===err){clearTimeout(errTimer);errTimer=setTimeout(function(){err.textContent=""},4000)}}
  function sendWs(o){if(ws&&ws.readyState===1)ws.send(JSON.stringify(o))}

  function restyle(){
    document.body.classList.toggle("adm",!!(me&&me.admin));
    var a=document.querySelectorAll(".m,.card");
    for(var i=0;i<a.length;i++)a[i].classList.toggle("own",!!(me&&a[i].dataset.name===me.name));
    who.textContent=me?(me.name+(me.admin?" ★":"")):"ログイン";
    sendBtn.disabled=!connected;
    stext.textContent=connected?(online+"人が参加中"):"接続し直しています…";
    dot.className=connected?"on":"";
  }

  /* ---------- チャット ---------- */
  function addMsg(m,force){
    var stick=force||nearBottom();
    var empty=list.querySelector(".empty");if(empty)empty.remove();
    var box=document.createElement("div");box.className="m";box.dataset.id=m.id;box.dataset.name=m.name;
    if(me&&me.name===m.name)box.classList.add("own");
    var meta=document.createElement("div");meta.className="meta";
    var b=document.createElement("b");b.textContent=m.name;
    var t=document.createElement("span");t.textContent=fmt(m.ts,false);
    var del=document.createElement("button");del.type="button";del.className="del";del.textContent="削除";
    meta.appendChild(b);meta.appendChild(t);meta.appendChild(del);
    var body=document.createElement("div");body.className="body";body.textContent=m.text;
    box.appendChild(meta);box.appendChild(body);list.appendChild(box);
    while(list.children.length>300)list.removeChild(list.firstChild);
    if(stick)list.scrollTop=list.scrollHeight;
  }
  list.addEventListener("click",function(e){
    var t=e.target;
    if(t&&t.classList&&t.classList.contains("del")){
      var box=t.closest(".m");
      if(box&&confirm("このメッセージを削除しますか?"))sendWs({type:"delmsg",id:box.dataset.id});
    }
  });

  /* ---------- 投稿 ---------- */
  function mediaEl(m){
    var u="/_nx/media/"+encodeURIComponent(m.key),el;
    if(m.kind==="image"){el=document.createElement("img");el.loading="lazy";el.alt=m.name||"";el.src=u}
    else if(m.kind==="audio"){el=document.createElement("audio");el.controls=true;el.preload="none";el.src=u}
    else{el=document.createElement("video");el.controls=true;el.playsInline=true;el.preload="metadata";el.src=u}
    el.className="media";
    return el;
  }
  function renderPost(p,atTop){
    var empty=feed.querySelector(".empty");if(empty)empty.remove();
    var c=document.createElement("article");c.className="card";c.dataset.id=p.id;c.dataset.name=p.name;
    if(me&&me.name===p.name)c.classList.add("own");
    var meta=document.createElement("div");meta.className="meta";
    var b=document.createElement("b");b.textContent=p.name;
    var t=document.createElement("span");t.textContent=fmt(p.ts,true);
    var del=document.createElement("button");del.type="button";del.className="del";del.textContent="削除";
    meta.appendChild(b);meta.appendChild(t);meta.appendChild(del);c.appendChild(meta);
    if(p.text){var tx=document.createElement("div");tx.className="text";tx.textContent=p.text;c.appendChild(tx)}
    if(p.media){
      c.appendChild(mediaEl(p.media));
      if(p.media.name){var cap=document.createElement("div");cap.className="cap";cap.textContent=p.media.name;c.appendChild(cap)}
    }
    if(atTop)feed.insertBefore(c,feed.firstChild);else feed.appendChild(c);
  }
  feed.addEventListener("click",function(e){
    var t=e.target;
    if(t&&t.classList&&t.classList.contains("del")){
      var c=t.closest(".card");
      if(c&&confirm("この投稿を削除しますか?"))sendWs({type:"delpost",id:c.dataset.id});
    }
  });

  function typeOf(f){
    var t=(f.type||"").toLowerCase();
    if(t==="audio/x-m4a")t="audio/mp4";
    if(t==="audio/x-wav")t="audio/wav";
    if(!KIND[t]){var n=f.name||"",i=n.lastIndexOf("."),e=i>=0?n.slice(i+1).toLowerCase():"";if(EXT[e])t=EXT[e]}
    return t;
  }
  $("pick").addEventListener("click",function(){$("pfile").click()});
  $("pfile").addEventListener("change",function(){
    var f=this.files&&this.files[0];if(!f)return;
    var t=typeOf(f),k=KIND[t];
    if(!k){showErr(perr,"対応していないファイル形式です");this.value="";return}
    if(f.size>LIM[k]*1048576){showErr(perr,"ファイルが大きすぎます(上限 "+LIM[k]+"MB)");this.value="";return}
    file=f;file.__t=t;showErr(perr,"");
    $("fname").textContent=f.name+" ("+(f.size/1048576).toFixed(1)+"MB)";$("pclear").hidden=false;
  });
  function clearFile(){file=null;$("pfile").value="";$("fname").textContent="画像 / 音声 / 動画";$("pclear").hidden=true}
  $("pclear").addEventListener("click",clearFile);

  $("pgo").addEventListener("click",function(){
    if(uploading)return;
    if(!me||!creds){openLogin("");return}
    var text=$("ptext").value.trim();
    if(!text&&!file){showErr(perr,"本文かファイルを入れてください");return}
    uploading=true;$("pgo").disabled=true;showErr(perr,"");
    var prog=$("pprog");prog.value=0;prog.hidden=!file;
    var x=new XMLHttpRequest();
    x.open("POST","/_nx/post");
    x.setRequestHeader("x-chat-name",encodeURIComponent(creds.name));
    x.setRequestHeader("x-chat-pass",encodeURIComponent(creds.pass));
    x.setRequestHeader("x-post-text",encodeURIComponent(text));
    if(file){x.setRequestHeader("content-type",file.__t);x.setRequestHeader("x-file-name",encodeURIComponent(file.name))}
    x.upload.onprogress=function(e){if(e.lengthComputable)prog.value=Math.round(e.loaded*100/e.total)};
    x.onload=function(){
      uploading=false;$("pgo").disabled=false;prog.hidden=true;
      if(x.status===200){$("ptext").value="";clearFile()}
      else{var m="投稿できませんでした";try{m=JSON.parse(x.responseText).error||m}catch(e){}showErr(perr,m)}
    };
    x.onerror=function(){uploading=false;$("pgo").disabled=false;prog.hidden=true;showErr(perr,"通信に失敗しました")};
    x.send(file||null);
  });

  /* ---------- ログイン ---------- */
  function openLogin(msg){
    $("dlg").hidden=false;$("derr").textContent=msg||"";
    $("dname").value=(me&&me.name)||(creds&&creds.name)||$("dname").value||"";
    $("dpass").value="";$("dout").hidden=!me;
    setTimeout(function(){try{($("dname").value?$("dpass"):$("dname")).focus()}catch(e){}},50);
  }
  function closeLogin(){$("dlg").hidden=true}
  who.addEventListener("click",function(){openLogin("")});
  $("dcancel").addEventListener("click",closeLogin);
  $("dbox").addEventListener("submit",function(e){
    e.preventDefault();
    var n=$("dname").value.trim(),p=$("dpass").value;
    if(!n){$("derr").textContent="名前を入力してください";return}
    if(p.length<10){$("derr").textContent="合言葉は10文字以上で入力してください";return}
    if(!connected){$("derr").textContent="接続中です。少し待ってからやり直してください";return}
    pending={name:n,pass:p};loginAuto=false;$("derr").textContent="";
    sendWs({type:"login",name:n,pass:p});
  });
  $("dout").addEventListener("click",function(){
    sendWs({type:"logout"});me=null;creds=null;
    clearCreds();
    restyle();closeLogin();
  });

  /* ---------- 接続 ---------- */
  function connect(){
    var proto=location.protocol==="https:"?"wss:":"ws:";
    ws=new WebSocket(proto+"//"+location.host+"/_nx/chat");
    ws.addEventListener("open",function(){
      retry=0;connected=true;restyle();
      if(creds){pending=creds;loginAuto=true;sendWs({type:"login",name:creds.name,pass:creds.pass})}
    });
    ws.addEventListener("message",function(e){
      var d;try{d=JSON.parse(e.data)}catch(x){return}
      if(d.type==="init"){
        list.textContent="";feed.textContent="";
        if(!d.history.length){var p=document.createElement("p");p.className="empty";p.textContent="まだ誰もいません。";list.appendChild(p)}
        d.history.forEach(function(m){addMsg(m,true)});
        if(!d.posts.length){var q=document.createElement("p");q.className="empty";q.textContent="まだ投稿がありません。";feed.appendChild(q)}
        for(var i=d.posts.length-1;i>=0;i--)renderPost(d.posts[i],false);
        online=d.online;restyle();
      }else if(d.type==="msg"){addMsg(d.msg,me&&d.msg.name===me.name)}
      else if(d.type==="post"){renderPost(d.post,true)}
      else if(d.type==="delmsg"){var m1=list.querySelector('.m[data-id="'+d.id+'"]');if(m1)m1.remove()}
      else if(d.type==="delpost"){var c1=feed.querySelector('.card[data-id="'+d.id+'"]');if(c1)c1.remove()}
      else if(d.type==="online"){online=d.online;restyle()}
      else if(d.type==="login_ok"){
        me={name:d.name,admin:!!d.admin};
        creds=pending||creds;
        saveCreds(creds);
        loginAuto=false;closeLogin();restyle();
      }else if(d.type==="login_error"){
        if(loginAuto&&/合言葉が違います/.test(d.text)){creds=null;clearCreds()}
        var wasAuto=loginAuto;loginAuto=false;
        openLogin(wasAuto?"保存してあったログインが使えませんでした: "+d.text:d.text);
      }else if(d.type==="error"){showErr(err,d.text)}
    });
    ws.addEventListener("close",function(){
      connected=false;restyle();
      var wait=Math.min(10000,1000*Math.pow(2,retry++));
      setTimeout(connect,wait);
    });
    ws.addEventListener("error",function(){try{ws.close()}catch(x){}});
  }

  function send(){
    var text=textIn.value.trim();
    if(!text)return;
    if(!me){openLogin("");return}
    if(!connected)return;
    sendWs({type:"msg",text:text});
    textIn.value="";textIn.style.height="44px";
  }
  $("form").addEventListener("submit",function(e){e.preventDefault();send()});
  /* 日本語入力の変換確定の Enter では送信しない */
  textIn.addEventListener("keydown",function(e){
    if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229){e.preventDefault();send()}
  });
  textIn.addEventListener("input",function(){
    textIn.style.height="44px";
    textIn.style.height=Math.min(120,textIn.scrollHeight)+"px";
  });

  /* タブ */
  var tabs=document.querySelectorAll("nav .tab");
  for(var ti=0;ti<tabs.length;ti++){
    tabs[ti].addEventListener("click",function(){
      var t=this.dataset.t;
      for(var j=0;j<tabs.length;j++)tabs[j].classList.toggle("on",tabs[j]===this);
      $("p-chat").classList.toggle("on",t==="chat");
      $("p-posts").classList.toggle("on",t==="posts");
      if(t==="chat")list.scrollTop=list.scrollHeight;
    });
  }

  document.addEventListener("visibilitychange",function(){
    if(!document.hidden&&!connected&&ws&&ws.readyState===WebSocket.CLOSED){retry=0;connect()}
  });

  restyle();connect();
})();
</script>
</body>
</html>`;

/* ============================== 検証 / 共通ユーティリティ ============================== */

const BLOCKED_HOST =
  /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|\[?::1\]?)$|^(10|127)\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./i;

/* Cloudflare Workers 1024 対策: Cloudflare 所有ホストは上流 fetch() に渡さない */
function isCloudflareOwnedTarget(u) {
  const host = String(u.hostname || "").toLowerCase().replace(/\.$/, "");
  return (
    host === "workers.dev" ||
    host.endsWith(".workers.dev") ||
    host === "pages.dev" ||
    host.endsWith(".pages.dev") ||
    host === "cloudflare.com" ||
    host.endsWith(".cloudflare.com") ||
    host === "cloudflareworkers.com" ||
    host.endsWith(".cloudflareworkers.com")
  );
}

/** 中継先として許可できる URL なら URL オブジェクトを返す */
function validateTarget(value, requestUrl) {
  let u;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  if (!ALLOW_PRIVATE && BLOCKED_HOST.test(u.hostname)) return null;
  if (isCloudflareOwnedTarget(u)) return null;
  // 1042 対策: このWorker自身を中継先にしない
  if (requestUrl && u.hostname.toLowerCase() === String(requestUrl.hostname).toLowerCase()) return null;
  return u;
}

function normalizeCharset(label) {
  if (!label) return null;
  const l = String(label).trim().toLowerCase().replace(/^["']|["']$/g, "");
  if (!l) return null;
  const alias = {
    "shift-jis": "shift_jis",
    sjis: "shift_jis",
    ms932: "shift_jis",
    "x-sjis": "shift_jis",
    "windows-31j": "shift_jis",
    "x-euc-jp": "euc-jp",
    utf8: "utf-8",
    latin1: "windows-1252",
    ascii: "utf-8",
  };
  const name = alias[l] || l;
  try {
    return new TextDecoder(name).encoding;
  } catch {
    return null;
  }
}

function charsetFromHeader(ct) {
  const m = /charset\s*=\s*["']?([\w.\-]+)/i.exec(ct || "");
  return m ? m[1] : null;
}

/** ヘッダに charset が無いとき、本文の先頭から <meta charset> を拾う */
function sniffCharset(bytes) {
  const head = bytes.subarray(0, Math.min(bytes.length, 2048));
  let probe = "";
  try {
    probe = new TextDecoder("windows-1252").decode(head);
  } catch {
    for (let i = 0; i < head.length; i++) probe += String.fromCharCode(head[i]);
  }
  let m = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_.\-]+)/i.exec(probe);
  if (m) return m[1];
  m = /<\?xml[^>]+encoding\s*=\s*["']([a-z0-9_.\-]+)/i.exec(probe);
  if (m) return m[1];
  return null;
}

function pickCharset(contentType, bytes) {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  }
  return (
    normalizeCharset(charsetFromHeader(contentType)) ||
    normalizeCharset(sniffCharset(bytes)) ||
    "utf-8"
  );
}

function decodeText(bytes, charset) {
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    try {
      return new TextDecoder("utf-8").decode(bytes);
    } catch {
      return "";
    }
  }
}

function getSetCookieValues(headers) {
  if (typeof headers.getSetCookie === "function") {
    try {
      return headers.getSetCookie();
    } catch {
      /* fallthrough */
    }
  }
  if (typeof headers.getAll === "function") {
    try {
      return headers.getAll("set-cookie");
    } catch {
      /* fallthrough */
    }
  }
  const one = headers.get("set-cookie");
  return one ? [one] : [];
}

function baseMediaType(ct, fallback) {
  const t = String(ct || "").split(";")[0].trim();
  return t || fallback;
}

function trySet(headers, name, value) {
  try {
    headers.set(name, value);
  } catch {
    /* ランタイムによって禁止されているヘッダ / 不正な値 */
  }
}

async function fetchWithTimeout(url, init) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("upstream timeout")), HEADERS_TIMEOUT_MS);
  });
  try {
    return await Promise.race([fetch(url, init), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function textResponse(body, status) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function htmlResponse(html) {
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;"
  );
}

function errorPage(title, err) {
  const detail = String((err && (err.stack || err.message)) || err || "");
  const html =
    '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escapeHtml(title) + "</title>" +
    '<style>body{font:15px/1.6 system-ui,-apple-system,sans-serif;background:#0f1017;color:#e8eaed;margin:0;padding:40px 18px}' +
    'h1{font-size:1.15rem;margin:0 0 10px}a{color:#8ba6ff}' +
    'pre{background:#16181f;border:1px solid #2b2f38;border-radius:10px;padding:12px;overflow:auto;font-size:12px;color:#c9d1d9}</style></head><body>' +
    "<h1>" + escapeHtml(title) + "</h1><pre>" + escapeHtml(detail) + "</pre>" +
    '<p><a href="' + escapeHtml(P_HOME) + '">ホームに戻る</a></p></body></html>';
  return new Response(html, {
    status: 502,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

// Nexora のロゴ（透過 PNG, 64x64 / 180x180）。base64 埋め込みなので別リクエストは発生しない
const FAVICON_B64 = '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';
const APPLE_ICON_B64 = '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';

function pngResponse(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
  });
}
function faviconResponse() {
  return pngResponse(FAVICON_B64);
}
function appleIconResponse() {
  return pngResponse(APPLE_ICON_B64);
}

/* ============================== ブートストラップ（SW 未登録のとき） ============================== */

function buildBootstrap() {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nexora</title>
<link rel="icon" href="/favicon.ico?v=${NEXORA_VERSION}" type="image/png">
<style>body{font:15px/1.7 system-ui,-apple-system,sans-serif;background:#0f0c29;color:#e8eaed;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;text-align:center;padding:20px}a{color:#8ba6ff}</style>
</head><body><div><p id="m">読み込み準備中…</p><p><a href="${P_HOME}">ホームに戻る</a></p></div>
<script>
(async function(){
  var m=document.getElementById("m");
  if(!("serviceWorker" in navigator)){m.textContent="このブラウザ（またはモード）は Service Worker に対応していません。";return}
  var tries=0;try{tries=+(sessionStorage.getItem("__nx_try")||0)}catch(e){}
  if(tries>=3){m.textContent="Service Worker を有効にできませんでした。ハードリロードやシークレットモードを避けて、ホームからもう一度開いてください。";return}
  try{sessionStorage.setItem("__nx_try",String(tries+1))}catch(e){}
  try{
    await navigator.serviceWorker.register("${P_SW}",{scope:"/"});
    await navigator.serviceWorker.ready;
    if(!navigator.serviceWorker.controller){
      await new Promise(function(r){navigator.serviceWorker.addEventListener("controllerchange",r,{once:true});setTimeout(r,3000)});
    }
    location.reload();
  }catch(e){m.textContent="エラー: "+e}
})();
</script></body></html>`;
}

/* ============================== ランディングページ ============================== */

const DEBUG_UI_HTML = `
<script data-nx-debug>(function(){
function boot(){
function initDiag(){
  if(window.__nxDiag)return window.__nxDiag;
  var d=window.__nxDiag={errors:[],startedAt:Date.now()};
  function add(k,m,s,l,c,st){try{var kind=String(k||'error'),message=String(m||k||'Error'),source=String(s||'');if(kind==='resource'){for(var i=d.errors.length-1;i>=0;i--){var old=d.errors[i];if(old.kind==='resource'&&old.source===source&&old.message===message){old.count=(old.count||1)+1;old.time=new Date().toLocaleTimeString();return}}}d.errors.push({kind:kind,message:message,source:source,line:Number(l)||0,column:Number(c)||0,stack:String(st||''),time:new Date().toLocaleTimeString(),count:1});if(d.errors.length>100)d.errors.splice(0,d.errors.length-100)}catch(x){}}
  d.add=add;
  addEventListener('error',function(e){var t=e&&e.target;if(t&&t!==window){var u=t.src||t.href||'';add('resource','Failed to load '+(u||t.tagName),u,0,0,'');return}add('error',e&&e.message||'Script error',e&&e.filename,e&&e.lineno,e&&e.colno,e&&e.error&&e.error.stack)},true);
  addEventListener('unhandledrejection',function(e){var r=e&&e.reason;add('rejection',r&&r.message||String(r),'',0,0,r&&r.stack||'')},true);
  try{var c=console,old=c&&c.error;if(c&&typeof old==='function'&&!c.__nxDiagWrapped){var f=function(){var a=Array.prototype.slice.call(arguments);add('console.error',a.map(function(x){try{return x&&x.stack||String(x)}catch(z){return '[unprintable]'}}).join(' '),'',0,0,a.map(function(x){return x&&x.stack||''}).join('\\n'));return old.apply(this,arguments)};c.error=f;try{Object.defineProperty(c,'__nxDiagWrapped',{value:true})}catch(z){c.__nxDiagWrapped=true}}}catch(x){}
  return d;
}
var diag=initDiag();
function cd(){try{var f=window.__nxActiveDiag&&window.__nxActiveDiag();if(f&&Array.isArray(f.errors))return f}catch(e){}return diag}
// 古い/不完全な host が残っている場合は再利用可能か確認し、壊れていれば作り直す。
var staleHost=document.getElementById('__nx_debug_host');
if(staleHost){
  var staleRoot=staleHost.shadowRoot||staleHost;
  var stalePanel=staleRoot.querySelector?staleRoot.querySelector('#p'):null;
  if(stalePanel){
    window.__nxDebugToggle=function(force){if(force===true){stalePanel.classList.add('show');stalePanel.setAttribute('aria-hidden','false')}else if(force===false){stalePanel.classList.remove('show');stalePanel.setAttribute('aria-hidden','true')}else{stalePanel.classList.toggle('show');stalePanel.setAttribute('aria-hidden',stalePanel.classList.contains('show')?'false':'true')}return true};
    if(window.__nxDebugPending){window.__nxDebugPending=false;window.__nxDebugToggle(true)}
    return;
  }
  try{staleHost.remove()}catch(e){if(staleHost.parentNode)staleHost.parentNode.removeChild(staleHost)}
}
var host=document.createElement('div');host.id='__nx_debug_host';host.setAttribute('data-nx','');
(host.attachShadow?host.attachShadow({mode:'open'}):host).innerHTML=
'<style>'+
':host{all:initial;display:block;pointer-events:none}*{box-sizing:border-box}button{font:inherit;touch-action:manipulation;pointer-events:auto}#p{pointer-events:auto;position:fixed;top:auto;right:auto;bottom:68px;left:12px;z-index:2147483645;width:min(430px,calc(100vw - 24px));max-height:min(76vh,680px);display:none;overflow:hidden;border:1px solid rgba(255,255,255,.13);border-radius:18px;background:rgba(9,10,17,.97);backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px);box-shadow:0 24px 80px rgba(0,0,0,.45);color:#f4f4ff;font:13px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}#p.show{display:block}.head{display:flex;align-items:center;justify-content:space-between;padding:14px 15px;border-bottom:1px solid rgba(255,255,255,.08)}.title{font-weight:700;letter-spacing:.08em}.ver{font-size:10px;color:#8888a5;margin-left:7px}.actions{display:flex;gap:6px}.actions button{border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.055);color:#dfe2ff;border-radius:9px;padding:7px 9px;font-size:11px;cursor:pointer}.body{padding:12px 14px;overflow:auto;max-height:calc(min(76vh,680px) - 56px);overscroll-behavior:contain}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-bottom:12px}.card{padding:9px;border:1px solid rgba(255,255,255,.07);border-radius:11px;background:rgba(255,255,255,.035)}.card b{display:block;font-size:15px}.card span{font-size:10px;color:#8d8da8}.section{font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:#8f8fa9;margin:12px 0 7px;display:flex;align-items:center;justify-content:space-between;gap:8px}.section button{border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.055);color:#dfe2ff;border-radius:8px;padding:5px 8px;font-size:10px;letter-spacing:0;text-transform:none;cursor:pointer}.section button:hover{background:rgba(255,255,255,.09)}.section button.copied{color:#8be0a7;border-color:rgba(139,224,167,.3)}.count{display:inline-block;margin-left:6px;color:#ff9da9}.list{display:flex;flex-direction:column;gap:5px}.row{display:grid;grid-template-columns:46px 1fr 42px 50px;gap:7px;align-items:center;padding:7px 8px;border-radius:9px;background:rgba(255,255,255,.035);min-width:0}.method{font-size:10px;color:#a99cff}.url{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d8d8e8}.status{text-align:right}.ms{text-align:right;color:#8c8ca5;font-size:10px}.ok{color:#8be0a7}.warn{color:#ffd27d}.err{color:#ff8e9b}.cache{font-size:9px;color:#9e8dff;margin-left:4px}.empty{padding:13px;text-align:center;color:#777791}.foot{font-size:10px;color:#6f6f88;margin-top:10px}.errlist{display:flex;flex-direction:column;gap:6px}.error{padding:9px;border:1px solid rgba(255,110,130,.16);border-radius:10px;background:rgba(255,90,110,.055);min-width:0}.errorHead{display:flex;justify-content:space-between;gap:8px;color:#ff9da9;font-size:10px;margin-bottom:4px}.errorMessage{color:#f3dce0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px}.error pre{margin:6px 0 0;color:#a9a5b8;font:10px/1.4 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:100px;overflow:auto}@media(max-width:560px){#p{bottom:62px;left:10px;width:calc(100vw - 20px);max-height:80vh}.row{grid-template-columns:42px 1fr 38px 44px}.grid{grid-template-columns:repeat(2,1fr)}}'+
'</style>'+
'<section id="p" aria-hidden="true"><div class="head"><div><span class="title">NEXORA DEBUG</span><span class="ver">v${NEXORA_VERSION}</span></div><div class="actions"><button id="rf" type="button" title="ページを再読み込み">⟳</button><button id="cl" type="button" title="ログとキャッシュをクリア">Clear</button><button id="x" type="button" title="閉じる">×</button></div></div><div class="body"><div class="grid"><div class="card"><b id="rq">0</b><span>Requests</span></div><div class="card"><b id="ch">0</b><span>Cache hits</span></div><div class="card"><b id="av">—</b><span>Avg ms</span></div><div class="card"><b id="sv">—</b><span>Server ms</span></div></div><div class="section"><span>Runtime Errors <span id="ec" class="count">0</span></span><button id="cp" type="button" title="エラーをコピー">Copy Errors</button></div><div id="el" class="errlist"><div class="empty">No errors captured</div></div><div class="section"><span>Request Monitor</span><button id="cm" type="button" title="リクエスト一覧をコピー">Copy Requests</button></div><div id="li" class="list"><div class="empty">Waiting for requests…</div></div><div class="foot" id="inf">Runtime errors and Service Worker requests are monitored locally.</div></div></section>';
var root=host.shadowRoot||host,panel=root.querySelector('#p');
(document.body||document.documentElement).appendChild(host);if(!panel)return;
var list=root.getElementById('li'),reqEl=root.getElementById('rq'),cacheEl=root.getElementById('ch'),avgEl=root.getElementById('av'),serverEl=root.getElementById('sv'),errorList=root.getElementById('el'),errorCount=root.getElementById('ec'),copyErrorsBtn=root.getElementById('cp');var monitorCopyBtn=root.getElementById('cm');
function esc(s){return String(s==null?'':s).replace(/[&<>\"']/g,function(c){return c==='&'?'&amp;':c==='<'?'&lt;':c==='>'?'&gt;':c==='\"'?'&quot;':'&#39;'})}
function getWorker(){return new Promise(function(resolve){var sw=navigator.serviceWorker;if(!sw){resolve(null);return}if(sw.controller){resolve(sw.controller);return}var done=false;var timer=setTimeout(function(){if(!done){done=true;resolve(null)}},1200);sw.ready.then(function(reg){if(done)return;done=true;clearTimeout(timer);resolve(reg.active||reg.waiting||reg.installing||null)}).catch(function(){if(!done){done=true;clearTimeout(timer);resolve(null)}})})}
function requestStats(){getWorker().then(function(sw){try{if(sw)sw.postMessage({t:'nx-debug-get'})}catch(e){}})}
function renderErrors(){var a=cd().errors;errorCount.textContent=a.length;if(!a.length){errorList.innerHTML='<div class="empty">No errors captured</div>';return}errorList.innerHTML=a.slice().reverse().slice(0,30).map(function(x){var head=String(x.kind||'error').toUpperCase()+' · '+String(x.time||'')+((x.count||1)>1?' · ×'+(x.count||1):'');var detail=(x.source||'')+(x.line?':'+x.line+(x.column?':'+x.column:''):'')+(x.stack?'\\n'+x.stack:'');return '<div class="error"><div class="errorHead"><b>'+esc(head)+'</b></div><div class="errorMessage">'+esc(x.message||'Unknown error')+'</div>'+(detail?'<pre>'+esc(detail)+'</pre>':'')+'</div>'}).join('')}
var monitorState=null;function render(d){monitorState=d||{};var a=d&&d.logs||[],hits=d&&d.cacheHits||0;reqEl.textContent=a.length;cacheEl.textContent=hits;var nums=a.map(function(x){return +x.ms||0}),sv=a.map(function(x){return +x.serverMs||0}).filter(Boolean);avgEl.textContent=nums.length?Math.round(nums.reduce(function(x,y){return x+y},0)/nums.length):'—';serverEl.textContent=sv.length?Math.round(sv.reduce(function(x,y){return x+y},0)/sv.length):'—';if(!a.length){list.innerHTML='<div class="empty">Waiting for requests…</div>'}else{list.innerHTML=a.slice().reverse().slice(0,50).map(function(x){var cls=x.status>=400?'err':x.status>=300?'warn':'ok',u=String(x.url||'');try{var z=new URL(u);u=z.hostname+z.pathname+(z.search?z.search:'')}catch(e){}return '<div class="row" title="'+esc((x.source||'unknown')+(x.detail?' · '+x.detail:''))+'"><span class="method">'+esc(x.method)+'</span><span class="url" title="'+esc(u)+'">'+esc(u)+(x.cache?'<small class="cache">CACHE</small>':'')+'<small class="cache">'+esc(x.source||'unknown')+'</small></span><span class="status '+cls+'">'+esc(x.status||'ERR')+'</span><span class="ms">'+esc(x.ms)+'ms'+(x.serverMs?' <small>('+esc(x.serverMs)+'ms upstream)</small>':'')+'</span></div>'}).join('')}renderErrors()}
function monitorText(){var d=monitorState||{};var a=d.logs||[];var out=['NEXORA DEBUG v${NEXORA_VERSION}','Requests: '+a.length,'Cache hits: '+(d.cacheHits||0),'','REQUEST MONITOR'];function safeUrl(raw){try{var u=new URL(String(raw||''));var sensitive=/^(ip|sig|lsig|sparams|signature|token|access_token|auth|key|pot|c|cpn|ei|of|id|expire|n|lsig|pltype)$/i;var pairs=[];u.searchParams.forEach(function(v,k){pairs.push(k+'=[REDACTED]')});return u.origin+u.pathname+(pairs.length?'?'+pairs.join('&'):'')}catch(e){return String(raw||'')}}if(!a.length)out.push('No requests captured');a.slice().reverse().slice(0,50).forEach(function(x,i){out.push('['+(i+1)+'] '+String(x.method||'')+' '+safeUrl(x.url)+' | status='+String(x.status||'ERR')+' | '+String(x.ms||0)+'ms'+(x.serverMs?' | upstream='+x.serverMs+'ms':'')+' | source='+String(x.source||'unknown')+(x.detail?' | detail='+String(x.detail):'')+(x.cache?' | cache=hit':''))});return out.join('\\n')}
function copyMonitor(){var text=monitorText();function ok(){if(monitorCopyBtn){monitorCopyBtn.textContent='Copied';monitorCopyBtn.classList.add('copied');setTimeout(function(){monitorCopyBtn.textContent='Copy Requests';monitorCopyBtn.classList.remove('copied')},1200)}}function fail(){if(monitorCopyBtn){monitorCopyBtn.textContent='Copy Failed';setTimeout(function(){monitorCopyBtn.textContent='Copy Requests'},1200)}}function fallback(){try{var ta=document.createElement('textarea');ta.value=text;ta.setAttribute('readonly','');ta.style.position='fixed';ta.style.opacity='0';ta.style.pointerEvents='none';document.body.appendChild(ta);ta.select();ta.setSelectionRange(0,ta.value.length);var done=document.execCommand('copy');ta.remove();done?ok():fail()}catch(e){fail()}}try{if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(text).then(ok).catch(fallback);else fallback()}catch(e){fallback()}}
function show(){panel.classList.add('show');panel.setAttribute('aria-hidden','false');requestStats();renderErrors()}function hide(){panel.classList.remove('show');panel.setAttribute('aria-hidden','true')}
// ナビバーから直接呼べる公開トグル。イベント伝播や初期化順に依存しない。
window.__nxDebugToggle=function(force){if(!panel)return false;if(force===true)show();else if(force===false)hide();else if(panel.classList.contains('show'))hide();else show();return true};
window.__nxDebugReady=true;
function reloadPage(){try{window.location.reload()}catch(e){location.reload()}}
function clearAll(){cd().errors.length=0;renderErrors();getWorker().then(function(sw){try{if(sw)sw.postMessage({t:'nx-debug-clear'})}catch(e){}setTimeout(requestStats,350)})}
function errorText(){var a=cd().errors;if(!a.length)return 'NEXORA DEBUG - Runtime Errors\\nNo errors captured';return a.map(function(x,i){var head=String(x.kind||'error').toUpperCase()+' · '+String(x.time||'')+((x.count||1)>1?' · ×'+(x.count||1):'');var detail=(x.source||'')+(x.line?':'+x.line+(x.column?':'+x.column:''):'');return '['+(i+1)+'] '+head+'\\n'+String(x.message||'Unknown error')+(detail?'\\n'+detail:'')+(x.stack?'\\n'+String(x.stack):'')}).join('\\n\\n')}
function copyErrors(){var text=errorText();function ok(){if(copyErrorsBtn){copyErrorsBtn.textContent='Copied';copyErrorsBtn.classList.add('copied');setTimeout(function(){copyErrorsBtn.textContent='Copy Errors';copyErrorsBtn.classList.remove('copied')},1200)}}function fail(){if(copyErrorsBtn){copyErrorsBtn.textContent='Copy Failed';setTimeout(function(){copyErrorsBtn.textContent='Copy Errors'},1200)}}try{if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(ok).catch(function(){fallback()})}else fallback()}catch(e){fallback()}function fallback(){try{var ta=document.createElement('textarea');ta.value=text;ta.setAttribute('readonly','');ta.style.position='fixed';ta.style.opacity='0';ta.style.pointerEvents='none';document.body.appendChild(ta);ta.select();ta.setSelectionRange(0,ta.value.length);var done=document.execCommand('copy');ta.remove();done?ok():fail()}catch(e){fail()}}}
function handleClick(e){var el=e.target;while(el&&el!==root&&el.tagName!=='BUTTON')el=el.parentNode;if(!el||el===root)return;if(el.id==='x'){e.preventDefault();hide()}else if(el.id==='rf'){e.preventDefault();reloadPage()}else if(el.id==='cl'){e.preventDefault();clearAll()}else if(el.id==='cp'){e.preventDefault();copyErrors()}else if(el.id==='cm'){e.preventDefault();copyMonitor()}}
root.addEventListener('click',handleClick,true);
root.addEventListener('pointerdown',function(e){var el=e.target;if(el&&el.closest&&el.closest('button'))e.stopPropagation()},true);
addEventListener('keydown',function(e){if(e.key==='Escape'&&panel.classList.contains('show'))hide()},true);
addEventListener('nx-open-debug',function(){if(typeof window.__nxDebugToggle==='function')window.__nxDebugToggle(true);else window.__nxDebugPending=true},{once:false});
// ホーム画面にはナビバー/Erudaがないため、左下に同じDebugトリガーを置く。
if(!document.getElementById('__nx_host')&&!document.documentElement.hasAttribute('data-nx-shell')){var homeTrigger=document.createElement('button');homeTrigger.type='button';homeTrigger.textContent='⌁';homeTrigger.title='NEXORA Debug';homeTrigger.setAttribute('aria-label','NEXORA Debug');homeTrigger.style.cssText='position:fixed;left:12px;bottom:12px;z-index:2147483646;width:42px;height:42px;border:1px solid rgba(133,155,255,.55);border-radius:13px;background:rgba(10,10,18,.9);color:#cbd5ff;font:700 19px system-ui;box-shadow:0 8px 24px rgba(0,0,0,.3);';homeTrigger.addEventListener('click',function(){panel.classList.contains('show')?hide():show()});(document.body||document.documentElement).appendChild(homeTrigger)}
if(navigator.serviceWorker)navigator.serviceWorker.addEventListener('message',function(e){if(e.data&&e.data.t==='nx-debug-state')render(e.data)});
setInterval(function(){if(panel.classList.contains('show')){requestStats();renderErrors()}},1500);
renderErrors();requestStats();
// ボタンが Debug UI 初期化より先に押された場合も、初期化直後に開く。
if(window.__nxDebugPending){window.__nxDebugPending=false;window.__nxDebugToggle(true)}
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",function(){try{boot()}catch(err){try{window.__nxDebugBootError=String(err&&err.stack||err);if(window.__nxDiag&&window.__nxDiag.add)window.__nxDiag.add('debug-boot',window.__nxDebugBootError,'',0,0,'')}catch(ignore){}}},{once:true});else{try{boot()}catch(err){try{window.__nxDebugBootError=String(err&&err.stack||err);if(window.__nxDiag&&window.__nxDiag.add)window.__nxDiag.add('debug-boot',window.__nxDebugBootError,'',0,0,'')}catch(ignore){}}}
})();</script>`;


/* ============================== ブラウザシェル（Nexora 3.0） ============================== */

const RW_SRC = String.raw`/* ============================== Nexora 書き換えモード ページ側スクリプト ============================== */
var CFG = self.__nxRw || { u: "", s: "" };
var O = location.origin, WR = O + "/~/";
var nativePost = window.postMessage;
function isHttp(u){return /^https?:/i.test(u)}
function rwWrap(abs){return nxRwWrap(O,abs)}
function rwUnwrap(h){h=String(h);if(h.indexOf(WR)!==0)return null;return nxRwUnwrapRest(h.slice(WR.length))||null}
function fromProxied(u){if(typeof u!=="string")return u;return rwUnwrap(u)||u}
function realBase(){return rwUnwrap(location.href)||CFG.u||location.href}
function segOf(){try{return nxEncUrl(new URL(realBase()).origin)}catch(e){return CFG.s}}

function toProxied(raw){
  if(typeof raw!=="string"||!raw)return raw;
  var t=raw.trim();
  if(!t||t.charAt(0)==="#"||/^(data|blob|javascript|mailto|tel|about|sms|geo):/i.test(t))return raw;
  if(t.indexOf(WR)===0)return raw;
  try{
    var u=new URL(t,realBase());
    if(u.protocol!=="http:"&&u.protocol!=="https:")return raw;
    if(u.origin===O){
      if(u.pathname.indexOf("/_nx/")===0)return raw;
      var rb=new URL(realBase());
      return rwWrap(rb.origin+u.pathname+u.search+u.hash)||raw;
    }
    return rwWrap(u.href)||raw;
  }catch(e){return raw}
}

/* ---- Service Worker 登録は拒否(プロキシ自身の SW と衝突するため) ---- */
try{
  if(navigator.serviceWorker){
    navigator.serviceWorker.register=function(){return Promise.reject(new Error("Service Worker registration disabled by Nexora"))};
  }
}catch(e){}
try{Object.defineProperty(navigator,"onLine",{value:true,configurable:true})}catch(e){}

/* ---- 属性 / プロパティ(代入の瞬間にプロキシ URL へ。読むと元の URL を返す) ---- */
var nGet=Element.prototype.getAttribute,nSet=Element.prototype.setAttribute;
var URL_ATTR={href:1,src:1,action:1,formaction:1,data:1,poster:1};
try{
  Element.prototype.setAttribute=function(name,value){
    try{
      if(URL_ATTR[String(name).toLowerCase()]&&this.tagName!=="BASE"&&typeof value==="string")value=toProxied(value);
    }catch(e){}
    return nSet.call(this,name,value);
  };
  Element.prototype.getAttribute=function(name){
    var v=nGet.call(this,name);
    try{if(URL_ATTR[String(name).toLowerCase()]&&this.tagName!=="BASE")return fromProxied(v)}catch(e){}
    return v;
  };
}catch(e){}
try{
  [[window.HTMLAnchorElement,"href"],[window.HTMLAreaElement,"href"],[window.HTMLScriptElement,"src"],
   [window.HTMLImageElement,"src"],[window.HTMLLinkElement,"href"],[window.HTMLIFrameElement,"src"],
   [window.HTMLVideoElement,"src"],[window.HTMLAudioElement,"src"],[window.HTMLSourceElement,"src"],
   [window.HTMLTrackElement,"src"],[window.HTMLEmbedElement,"src"],[window.HTMLObjectElement,"data"],
   [window.HTMLFormElement,"action"]].forEach(function(p){
    var C=p[0],prop=p[1];
    try{
      if(!C||!C.prototype)return;
      var d=Object.getOwnPropertyDescriptor(C.prototype,prop);
      if(!d||!d.get||!d.set)return;
      Object.defineProperty(C.prototype,prop,{
        get:function(){return fromProxied(d.get.call(this))},
        set:function(v){d.set.call(this,toProxied(String(v)))},
        configurable:true,enumerable:d.enumerable
      });
    }catch(e){}
  });
}catch(e){}

/* ---- ネットワーク API ---- */
function rebuild(req,nu){
  var o={method:req.method,headers:req.headers,credentials:req.credentials,redirect:req.redirect,signal:req.signal,cache:req.cache,referrerPolicy:req.referrerPolicy};
  if(req.mode&&req.mode!=="navigate")o.mode=req.mode;
  if(req.body&&req.method!=="GET"&&req.method!=="HEAD"){
    return req.clone().arrayBuffer().then(function(b){o.body=b;return new Request(nu,o)},function(){return req});
  }
  try{return Promise.resolve(new Request(nu,o))}catch(e){return Promise.resolve(req)}
}
try{
  var oFetch=window.fetch;
  window.fetch=function(input,init){
    var self=this;
    try{
      if(typeof input==="string")return oFetch.call(self,toProxied(input),init);
      if(input&&typeof input.url==="string"){
        var nu=toProxied(input.url);
        if(nu!==input.url)return rebuild(input,nu).then(function(r){return oFetch.call(self,r,init)});
        return oFetch.call(self,input,init);
      }
      if(input&&typeof input.href==="string")return oFetch.call(self,toProxied(input.href),init);
    }catch(e){}
    return oFetch.call(self,input,init);
  };
}catch(e){}
try{
  var oOpenX=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(method,url){
    try{if(url!==undefined&&url!==null)arguments[1]=toProxied(String(url))}catch(e){}
    return oOpenX.apply(this,arguments);
  };
}catch(e){}
try{
  if(typeof window.EventSource==="function"){
    var OES=window.EventSource;
    var PES=function(u,o){return new OES(toProxied(String(u)),o)};
    PES.prototype=OES.prototype;PES.CONNECTING=0;PES.OPEN=1;PES.CLOSED=2;
    window.EventSource=PES;
  }
}catch(e){}
try{
  if(navigator.sendBeacon){
    var oBeacon=navigator.sendBeacon;
    navigator.sendBeacon=function(u,d){var x=u;try{x=toProxied(String(u))}catch(e){}return oBeacon.call(navigator,x,d)};
  }
}catch(e){}
["Worker","SharedWorker"].forEach(function(name){
  try{
    var C=window[name];if(typeof C!=="function")return;
    var W=function(u,o){
      var x=u;
      try{if(typeof u==="string"||(u&&typeof u.href==="string"))x=toProxied(String(u))}catch(e){}
      return o!==undefined?new C(x,o):new C(x);
    };
    W.prototype=C.prototype;window[name]=W;
  }catch(e){}
});
try{
  var WS=window.WebSocket;
  if(typeof WS==="function"){
    var wsUrl=function(u){
      try{
        var r=new URL(String(u),realBase());
        if(r.protocol==="http:")r.protocol="ws:";else if(r.protocol==="https:")r.protocol="wss:";
        if(r.protocol!=="ws:"&&r.protocol!=="wss:")return u;
        if(r.host===location.host){
          var b=new URL(realBase());
          r=new URL(r.pathname+r.search,b);
          r.protocol=b.protocol==="https:"?"wss:":"ws:";
        }
        var cookie="";
        try{cookie=document.cookie||""}catch(e){}
        return O.replace(/^http/,"ws")+"/_nx/ws?u="+nxEncUrl(r.href)+"&o="+nxEncUrl(new URL(realBase()).origin)+(cookie?"&c="+nxEncUrl(cookie):"");
      }catch(e){return u}
    };
    var NWS=function(u,p){var pu=wsUrl(u);return p===undefined?new WS(pu):new WS(pu,p)};
    NWS.prototype=WS.prototype;
    ["CONNECTING","OPEN","CLOSING","CLOSED"].forEach(function(k,i){NWS[k]=i});
    window.WebSocket=NWS;
  }
}catch(e){}

/* ---- シェルとの連携(タブの根フレームだけが報告する) ---- */
var DOCID=Math.random().toString(36).slice(2)+Date.now().toString(36);
function inShell(){
  try{return window.parent!==window&&window.parent===window.top&&window.top.document.documentElement.hasAttribute("data-nx-shell")}catch(e){return false}
}
function shellApi(){try{return inShell()?window.top.__nxShell:null}catch(e){return null}}
var lastTitle=null;
function report(t){
  if(!inShell())return;
  try{nativePost.call(window.parent,{__nx:"nav",t:t,url:realBase(),doc:DOCID,title:document.title||""},O)}catch(e){}
}
function updateBase(){
  try{
    var b=document.querySelector("base");
    if(b&&location.href.indexOf(WR)===0)nSet.call(b,"href",location.href.split("#")[0]);
  }catch(e){}
}

/* ---- history / window.open ---- */
try{
  ["pushState","replaceState"].forEach(function(k){
    var o=History.prototype[k];
    History.prototype[k]=function(s,t,u){
      if(u!==undefined&&u!==null&&u!==""){try{u=toProxied(String(u))}catch(e){}}
      var rv=o.call(this,s,t,u);
      updateBase();
      report(k==="pushState"?"push":"replace");
      return rv;
    };
  });
}catch(e){}
window.addEventListener("popstate",function(){updateBase();report("nav")});
window.addEventListener("hashchange",function(){updateBase();report("nav")});
try{
  var oWinOpen=window.open;
  window.open=function(u,target,features){
    try{
      if(u&&!/^about:/i.test(String(u))){
        var api=shellApi();
        var tg=String(target===undefined||target===null||target===""?"_blank":target).toLowerCase();
        var abs=null;
        try{abs=new URL(fromProxied(String(u)),realBase()).href}catch(e){abs=null}
        if(api&&tg==="_blank"&&abs&&isHttp(abs)){var w=api.openTab(abs);if(w)return w}
        u=toProxied(String(u));
      }
    }catch(e){}
    return oWinOpen.call(window,u,target,features);
  };
}catch(e){}
document.addEventListener("click",function(ev){
  try{
    if(ev.defaultPrevented||ev.button!==0)return;
    var el=ev.target;
    while(el&&el.nodeType===1&&el.tagName!=="A"&&el.tagName!=="AREA")el=el.parentElement;
    if(!el)return;
    var api=shellApi();
    if(!api||ev.metaKey||ev.ctrlKey||ev.shiftKey||ev.altKey||nGet.call(el,"download")!==null)return;
    var raw=nGet.call(el,"href");
    if(raw===null||raw==="")return;
    var tg=String(nGet.call(el,"target")||"").toLowerCase();
    if(tg!=="_blank"&&tg!=="_top"&&tg!=="_parent")return;
    var abs;
    try{abs=fromProxied(new URL(raw,document.baseURI).href)}catch(e){return}
    if(!isHttp(abs))return;
    ev.preventDefault();
    if(tg==="_blank")api.openTab(abs);else location.href=toProxied(abs);
  }catch(e){}
},true);

/* ---- document.cookie(rw_ 接頭辞のクッキーだけを、元の名前で見せる) ---- */
try{
  var cd=Object.getOwnPropertyDescriptor(Document.prototype,"cookie");
  if(cd&&cd.get&&cd.set){
    Object.defineProperty(Document.prototype,"cookie",{
      configurable:true,enumerable:cd.enumerable,
      get:function(){
        var raw="";try{raw=cd.get.call(this)}catch(e){}
        var out=[],parts=raw?raw.split(";"):[];
        for(var i=0;i<parts.length;i++){var c=parts[i].trim();if(c.indexOf("rw_")===0)out.push(c.slice(3))}
        return out.join("; ");
      },
      set:function(v){
        try{
          var parts=String(v).split(";"),first=parts.shift()||"",eq=first.indexOf("=");
          if(eq<=0)return;
          var name=first.slice(0,eq).trim(),value=first.slice(eq+1).trim(),age=null;
          for(var i=0;i<parts.length;i++){
            var p=parts[i],j=p.indexOf("="),k=(j<0?p:p.slice(0,j)).trim().toLowerCase(),val=j<0?"":p.slice(j+1).trim();
            if(k==="max-age"){var n=parseInt(val,10);if(!isNaN(n))age=Math.max(0,n)}
            else if(k==="expires"){var t=Date.parse(val);if(!isNaN(t))age=Math.max(0,Math.floor((t-Date.now())/1000))}
          }
          var c="rw_"+name+"="+value+"; Path=/~/"+segOf()+"; SameSite=Lax; Secure";
          if(age!==null)c+="; Max-Age="+Math.min(age,31536000);
          cd.set.call(this,c);
        }catch(e){}
      }
    });
  }
}catch(e){}

/* ---- postMessage: 全フレームが同じオリジンなので targetOrigin の照合を無効にする ---- */
function patchPM(w){
  try{
    if(!w||w.__nxPM)return;
    var o=w.postMessage;
    if(typeof o!=="function")return;
    Object.defineProperty(w,"__nxPM",{value:true});
    w.postMessage=function(m,t){
      var a=Array.prototype.slice.call(arguments);
      try{
        if(typeof a[1]==="string"&&a[1]!=="*")a[1]="*";
        else if(a[1]&&typeof a[1]==="object"&&typeof a[1].targetOrigin==="string"&&a[1].targetOrigin!=="*")a[1]=Object.assign({},a[1],{targetOrigin:"*"});
      }catch(e){}
      return o.apply(w,a);
    };
  }catch(e){}
}
patchPM(window);
try{
  var cw=Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,"contentWindow");
  if(cw&&cw.get){
    Object.defineProperty(HTMLIFrameElement.prototype,"contentWindow",{
      get:function(){var w=cw.get.call(this);patchPM(w);return w},
      configurable:true
    });
  }
}catch(e){}
/* event.origin: 別サイトのフレームからなら、そのサイトの本来のオリジンを返す(自分のサイトからなら今のまま) */
try{
  var md=Object.getOwnPropertyDescriptor(MessageEvent.prototype,"origin");
  if(md&&md.get){
    Object.defineProperty(MessageEvent.prototype,"origin",{
      get:function(){
        var o=md.get.call(this);
        try{
          if(o===O){
            var s=this.source;
            if(s&&s.location){
              var r=rwUnwrap(s.location.href);
              if(r){
                var ro=new URL(r).origin;
                if(ro!==new URL(realBase()).origin)return ro;
              }
            }
          }
        }catch(e){}
        return o;
      },
      configurable:true,enumerable:md.enumerable
    });
  }
}catch(e){}

/* ---- 動的に追加された要素の URL を直す ---- */
var ATTRS={A:"href",AREA:"href",LINK:"href",SCRIPT:"src",IMG:"src",IFRAME:"src",FRAME:"src",VIDEO:"src",AUDIO:"src",SOURCE:"src",TRACK:"src",EMBED:"src",OBJECT:"data",FORM:"action",INPUT:"src"};
var SEL="a[href],area[href],link[href],script[src],img[src],iframe[src],frame[src],video[src],audio[src],source[src],track[src],embed[src],object[data],form[action],input[src]";
function fixEl(el){
  try{
    var a=ATTRS[el.tagName];
    if(!a)return;
    var v=nGet.call(el,a);
    if(!v||v.charAt(0)==="#"||/^(javascript|data|blob|mailto|tel|about):/i.test(v)||v.indexOf(WR)===0)return;
    var n=toProxied(v);
    if(n&&n!==v)nSet.call(el,a,n);
  }catch(e){}
}
function scan(node){
  if(!node||node.nodeType!==1)return;
  fixEl(node);
  if(node.querySelectorAll){var l=node.querySelectorAll(SEL);for(var i=0;i<l.length;i++)fixEl(l[i])}
}
try{
  if(typeof MutationObserver==="function"){
    new MutationObserver(function(recs){
      var added=[];
      for(var i=0;i<recs.length;i++){
        var an=recs[i].addedNodes;
        for(var j=0;j<an.length;j++)if(an[j].nodeType===1)added.push(an[j]);
      }
      if(!added.length)return;
      var batch=new Set(added);
      for(var k=0;k<added.length;k++){
        var covered=false;
        for(var anc=added[k].parentNode;anc;anc=anc.parentNode){if(batch.has(anc)){covered=true;break}}
        if(!covered)scan(added[k]);
      }
    }).observe(document.documentElement,{childList:true,subtree:true});
  }
}catch(e){}

report("init");
window.addEventListener("load",function(){report("title")});
try{
  if(inShell())setInterval(function(){var tt=document.title||"";if(tt!==lastTitle){lastTitle=tt;report("title")}},1500);
}catch(e){}
`;

const SHELL_JS = String.raw`(function(){
"use strict";
var ORIGIN=location.origin, HOME="nexora://home", MAXTABS=12;
var P_START=@@PSTART@@, P_SW=@@PSW@@, SEARCH_BASE=@@SEARCH@@, ERUDA=@@ERUDA@@, RW_DEFAULT=@@RWDEF@@, COMMUNITY=@@COMMUNITY@@;
var $=function(id){return document.getElementById(id)};
var app=$("app"), stage=$("stage"), tabl=$("tabl"), urlIn=$("url"), toastEl=$("toast"), bannerEl=$("banner");
var tabs=[], active=null, seq=0, saveTimer=0, holdSave=false, savedForBanner=null;

/* ---------- helpers ---------- */
function http(u){return /^https?:\/\//i.test(String(u))}
function isHome(u){return u===HOME}
function isCom(u){return String(u||"").indexOf(COMMUNITY)===0}
function clean(u){
  u=String(u||"");
  for(var i=0;i<4;i++){
    var r=null;
    if(u.indexOf(ORIGIN+"/-----")===0)r=nxUnwrapRest(u.slice((ORIGIN+"/-----").length));
    else if(u.indexOf(ORIGIN+"/~/")===0)r=nxRwUnwrapRest(u.slice((ORIGIN+"/~/").length));
    else{
      /* "https://<site>/-----token": an encrypted path glued onto the real host (leaked native location) */
      try{var uu=new URL(u);if(uu.pathname.indexOf("/-----")===0)r=nxUnwrapRest(uu.pathname.slice(6)+uu.search+uu.hash)}catch(e){}
    }
    if(!r||!http(r))break;
    u=r;
  }
  return u;
}
function frameReal(t){
  try{
    var h=t.frame.contentWindow.location.href;
    if(h.indexOf(ORIGIN+"/-----")===0)return nxUnwrapRest(h.slice((ORIGIN+"/-----").length))||"";
    if(h.indexOf(ORIGIN+"/~/")===0)return nxRwUnwrapRest(h.slice((ORIGIN+"/~/").length))||"";
  }catch(e){}
  return "";
}
function frameSrc(u){
  if(isHome(u))return ORIGIN+P_START;
  if(isCom(u))return u;
  var c=clean(u);
  if(useRw(c)){var w=nxRwWrap(ORIGIN,c);if(w)return w}
  return ORIGIN+nxWrapUrl("",c);
}
/* ---------- 書き換えモード(サイト別) ---------- */
function rwList(){try{var s=JSON.parse(localStorage.getItem("__nx_rwhosts")||"null");if(Array.isArray(s))return s}catch(e){}return RW_DEFAULT.slice()}
function rwMatch(host,list){host=String(host||"").toLowerCase();for(var i=0;i<list.length;i++){var d=list[i];if(host===d||host.endsWith("."+d))return true}return false}
function useRw(u){try{return rwMatch(new URL(u).hostname,rwList())}catch(e){return false}}
function syncRwToSw(){try{var c=navigator.serviceWorker&&navigator.serviceWorker.controller;if(c)c.postMessage({t:"nx-rw-hosts",list:rwList()})}catch(e){}}
function hostOf(u){if(isHome(u))return "ホーム";if(isCom(u))return "コミュニティ";try{return new URL(u).hostname||u}catch(e){return u}}
function isUrl(s){s=(s||"").trim();if(!s)return false;var l=s.toLowerCase();if(l.indexOf("http://")===0||l.indexOf("https://")===0)return true;if(/\s/.test(s))return false;if(/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s))return true;return /[.][a-zA-Z]{2,}/.test(s)}
function normalize(v){var t=(v||"").trim();if(!t)return null;if(isUrl(t)){var l=t.toLowerCase();var u=(l.indexOf("http://")===0||l.indexOf("https://")===0)?t:"https://"+t;return http(u)?u:null}return SEARCH_BASE+encodeURIComponent(t)}
function toast(m){toastEl.textContent=m;toastEl.classList.add("show");clearTimeout(toast.t);toast.t=setTimeout(function(){toastEl.classList.remove("show")},2600)}
function cur(t){return t.entries[t.idx]}

/* ---------- tab strip ---------- */
var ICON_X='<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
function badge(url){
  if(isHome(url))return {home:true,letter:"N",hue:260};
  var h=hostOf(url).replace(/^www\./,""),n=0;
  for(var i=0;i<h.length;i++)n=(n*31+h.charCodeAt(i))>>>0;
  return {home:false,letter:(h.charAt(0)||"?").toUpperCase(),hue:n%360};
}
function setBadge(el,b){el.className="bd"+(b.home?" home":"");el.textContent=b.letter;el.style.setProperty("--h",b.hue)}
function makeTabEl(t){
  var el=document.createElement("div");el.className="tab";
  var bd=document.createElement("span");
  var lab=document.createElement("span");lab.className="lab";
  var x=document.createElement("button");x.type="button";x.className="x";x.innerHTML=ICON_X;x.setAttribute("aria-label","タブを閉じる");
  el.appendChild(bd);el.appendChild(lab);el.appendChild(x);
  el.addEventListener("click",function(e){if(e.target===x||(x.contains&&x.contains(e.target)))closeTab(t);else activate(t)});
  t.label=lab;t.bd=bd;
  return el;
}
function refreshTab(t){
  var e=cur(t);
  t.label.textContent=isHome(e.url)?"ホーム":hostOf(e.url).replace(/^www\./,"");
  setBadge(t.bd,badge(e.url));
  t.el.classList.toggle("loading",!!t.loading);
  t.el.title=isHome(e.url)?"ホーム":(t.title||hostOf(e.url));
  updateChrome();
}
function updateChrome(){
  var c=$("tabcount");if(c)c.textContent=tabs.length;
  var lb=$("loadbar");if(lb)lb.classList.toggle("on",!!(active&&active.loading));
  var rl=$("reload");if(rl)rl.classList.toggle("spin",!!(active&&active.loading));
}

/* ---------- persistence (session restore) ---------- */
function doSave(){
  if(holdSave)return;
  try{
    localStorage.setItem("__nx_shell",JSON.stringify({v:1,active:Math.max(0,tabs.indexOf(active)),tabs:tabs.map(function(t){
      var es=t.entries.slice(-20),off=t.entries.length-es.length;
      return {idx:Math.max(0,t.idx-off),entries:es.map(function(e){return {url:e.url}})};
    })}));
  }catch(e){}
}
function save(){clearTimeout(saveTimer);saveTimer=setTimeout(doSave,400)}
window.addEventListener("pagehide",doSave);
function loadSaved(){try{var s=JSON.parse(localStorage.getItem("__nx_shell")||"null");if(s&&s.v===1&&Array.isArray(s.tabs)&&s.tabs.length)return s}catch(e){}return null}
function meaningful(s){return s.tabs.some(function(t){var e=t.entries&&t.entries[t.idx];return e&&http(e.url)})}

/* ---------- address bar ---------- */
function syncChrome(){
  var home=!active||isHome(cur(active).url)||isCom(cur(active).url);
  app.classList.toggle("nobar",home);
  var openBtn=$("open");
  openBtn.style.display=(app.classList.contains("min")&&!home)?"inline-flex":"none";
}
function setUrlView(u){
  var h=$("uvhost"),p=$("uvpath"),ic=$("urlicon");
  if(!u){h.textContent="";p.textContent="";ic.setAttribute("data-s","h");return}
  try{
    var x=new URL(u);
    h.textContent=x.hostname.replace(/^www\./,"");
    var rest=(x.pathname==="/"?"":x.pathname)+x.search+x.hash;
    try{rest=decodeURI(rest)}catch(e){}
    p.textContent=rest.length>80?rest.slice(0,80)+"…":rest;
    ic.setAttribute("data-s",x.protocol==="https:"?"s":"i");
  }catch(e){h.textContent=u;p.textContent="";ic.setAttribute("data-s","i")}
}
function updateBar(force){
  syncChrome();
  if(!active)return;
  var e=cur(active);
  if(force||document.activeElement!==urlIn)urlIn.value=isHome(e.url)?"":e.url;
  setUrlView(isHome(e.url)?"":e.url);
  $("back").disabled=!(active.idx>0);
  $("fwd").disabled=!(active.idx<active.entries.length-1);
  updateChrome();
}
function onChange(t){
  refreshTab(t);
  if(t===active){
    updateBar();
    var e=cur(t);
    if(e&&http(e.url)){try{localStorage.setItem("__nx_last_session",e.url)}catch(x){}}
  }
  save();
}

/* ---------- frames ---------- */
var SANDBOX="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-orientation-lock allow-presentation";
function mountFrame(t){
  var f=document.createElement("iframe");
  f.className="tf";
  f.setAttribute("sandbox",SANDBOX);
  f.setAttribute("allow","autoplay; fullscreen; encrypted-media; picture-in-picture; clipboard-write; gamepad; web-share");
  f.setAttribute("allowfullscreen","");
  f.addEventListener("load",function(){onFrameLoad(t)});
  t.frame=f;t.loading=true;
  f.src=frameSrc(cur(t).url);
  stage.appendChild(f);
  if(t===active)f.classList.add("on");
  refreshTab(t);
}
function loadFrame(t,url,replace){
  t.loading=true;
  if(!t.frame){mountFrame(t);return}
  var src=frameSrc(url),w=null;
  try{w=t.frame.contentWindow}catch(e){}
  try{if(replace&&w){w.location.replace(src);refreshTab(t);return}}catch(e){}
  t.frame.src=src;
  refreshTab(t);
}
function onFrameLoad(t){
  t.loading=false;
  var w=null,href="";
  try{w=t.frame.contentWindow;href=w.location.href}catch(e){}
  if(href.indexOf(ORIGIN+P_START)===0){
    applyHome(t);
  }else if(t.expect&&href.indexOf(ORIGIN+"/-----")===0){
    /* the page did not report (e.g. a Nexora error page): derive the URL from the frame location */
    var real=nxUnwrapRest(href.slice((ORIGIN+"/-----").length));
    if(real&&http(clean(real)))handleReport(t,{t:"init",url:real,doc:"load:"+Date.now(),title:""});
  }
  try{if(w&&w.document&&w.document.title&&href.indexOf(ORIGIN+P_START)!==0)t.title=String(w.document.title).slice(0,120)}catch(e){}
  /* iPad: a stale focused field from the previous page can make the keyboard pop up on any tap -> move focus into the new page */
  try{if(t===active&&document.activeElement!==urlIn&&w)w.focus()}catch(e){}
  onChange(t);
}
function applyHome(t){
  var ex=t.expect;t.expect=null;
  if(ex){var c=cur(t);c.url=HOME;c.doc="home"}
  else linkNav(t,HOME,"home:"+Date.now());
  t.title="";
}

/* ---------- navigation manager ---------- */
function navigate(t,url){
  url=clean(url);
  t.entries.splice(t.idx+1);
  t.entries.push({url:url,doc:null});
  t.idx=t.entries.length-1;
  t.expect="goto";
  loadFrame(t,url,true);
  onChange(t);
}
function step(t,d){
  var ni=t.idx+d;
  if(ni<0||ni>=t.entries.length)return;
  var c=cur(t),n=t.entries[ni];
  var nowU=frameReal(t);
  if(c.doc&&n.doc&&c.doc===n.doc&&t.frame&&t.frame.contentWindow&&nowU&&nowU.split("#")[0]===c.url.split("#")[0]){
    try{
      t.idx=ni;t.frame.contentWindow.history.go(d);onChange(t);
      var tt=t,target=n.url;
      /* self-heal: if the browser history and ours disagree, load the wanted URL directly */
      setTimeout(function(){
        if(tabs.indexOf(tt)<0||tt.idx!==ni)return;
        var now=frameReal(tt);
        if(now&&now.split("#")[0]!==target.split("#")[0]){tt.expect="restore";loadFrame(tt,target,true)}
      },1400);
      return;
    }catch(e){t.idx=ni-d}
  }
  t.idx=ni;
  t.expect="restore";
  loadFrame(t,n.url,true);
  onChange(t);
}
function reload(t){
  if(!t.frame){loadFrame(t,cur(t).url,true);return}
  t.expect="reload";t.loading=true;refreshTab(t);
  try{t.frame.contentWindow.location.reload()}catch(e){loadFrame(t,cur(t).url,true)}
}
function linkNav(t,url,doc){
  var c=cur(t),prev=t.entries[t.idx-1],next=t.entries[t.idx+1];
  if(c&&c.url===url&&!c.doc){c.doc=doc;return}
  if(prev&&prev.url===url){t.idx--;prev.doc=doc;return}
  if(next&&next.url===url){t.idx++;next.doc=doc;return}
  if(c&&c.url===url){c.doc=doc;return}
  t.entries.splice(t.idx+1);
  t.entries.push({url:url,doc:doc});
  t.idx=t.entries.length-1;
}
function handleReport(t,d){
  var url=clean(d.url);
  if(!http(url))return;
  var c=cur(t),typ=d.t;
  if(typ==="title"){
    if(!c.doc||c.doc===d.doc){t.title=String(d.title||"").slice(0,120);refreshTab(t)}
    return;
  }
  if(typ==="init"){
    var ex=t.expect;t.expect=null;
    if(ex==="goto"||ex==="restore"||ex==="reload"){c.url=url;c.doc=d.doc}
    else linkNav(t,url,d.doc);
    t.title=d.title||"";
  }else if(typ==="push"){
    t.entries.splice(t.idx+1);
    t.entries.push({url:url,doc:d.doc});
    t.idx=t.entries.length-1;
  }else if(typ==="replace"){
    c.url=url;c.doc=d.doc;
  }else if(typ==="nav"){
    var prev=t.entries[t.idx-1],next=t.entries[t.idx+1];
    if(prev&&prev.url===url&&prev.doc===d.doc)t.idx--;
    else if(next&&next.url===url&&next.doc===d.doc)t.idx++;
    else if(c.url===url&&c.doc===d.doc){/* same entry */}
    else if(c.doc===d.doc){t.entries.splice(t.idx+1);t.entries.push({url:url,doc:d.doc});t.idx=t.entries.length-1}
    else linkNav(t,url,d.doc);
  }
  onChange(t);
}
window.addEventListener("message",function(e){
  if(e.origin!==ORIGIN)return;
  var d=e.data;
  if(d&&d.__nx==="home-ready"){onHomeReady();return}
  if(!d||d.__nx!=="nav"||typeof d.url!=="string")return;
  for(var i=0;i<tabs.length;i++){
    var t=tabs[i];
    if(t.frame&&t.frame.contentWindow===e.source){handleReport(t,d);return}
  }
});

/* ---------- tab manager ---------- */
function createTab(url,o){
  o=o||{};
  if(tabs.length>=MAXTABS){toast("タブは最大"+MAXTABS+"個までです");return null}
  var t={id:++seq,entries:o.entries||[{url:clean(url)||HOME,doc:null}],idx:o.idx||0,frame:null,expect:null,loading:false,title:""};
  t.el=makeTabEl(t);
  tabl.appendChild(t.el);
  tabs.push(t);
  refreshTab(t);
  if(o.activate)activate(t);
  else if(!o.lazy)mountFrame(t);
  return t;
}
function activate(t){
  active=t;
  for(var i=0;i<tabs.length;i++){
    var x=tabs[i];
    x.el.classList.toggle("on",x===t);
    if(x.frame){
      x.frame.classList.toggle("on",x===t);
      x.frame.style.display=(x===t||!isHome(cur(x).url))?"":"none";
    }
  }
  if(!t.frame)mountFrame(t);
  updateBar(true);
  try{t.el.scrollIntoView({block:"nearest",inline:"nearest"})}catch(e){}
  save();
}
function closeTab(t){
  var i=tabs.indexOf(t);
  if(i<0)return;
  tabs.splice(i,1);
  if(t.frame){try{t.frame.src="about:blank"}catch(e){}t.frame.remove()}
  t.el.remove();
  if(!tabs.length){createTab(HOME,{activate:true});return}
  if(active===t)activate(tabs[Math.min(i,tabs.length-1)]);
  updateChrome();
  save();
}

/* API for pages inside the frames (same origin; every call is validated here) */
window.__nxShell={
  openTab:function(url){
    url=String(url||"");
    if(!http(url))return null;
    try{var ua=navigator.userActivation;if(ua&&!ua.isActive)return null}catch(e){}
    var t=createTab(url,{activate:true});
    return t&&t.frame?t.frame.contentWindow:null;
  }
};
window.__nxActiveDiag=function(){try{return active&&active.frame&&active.frame.contentWindow.__nxDiag}catch(e){return null}};
/* top.location / parent.location (rewritten to __location) must work for pages whose top is this shell */
(function(){
  function topLoc(){
    var u="about:blank";
    try{if(active&&http(cur(active).url))u=cur(active).url}catch(e){}
    var x;try{x=new URL(u)}catch(e){x=new URL("about:blank")}
    return {href:x.href,origin:x.origin,protocol:x.protocol,host:x.host,hostname:x.hostname,port:x.port,
      pathname:x.pathname,search:x.search,hash:x.hash,ancestorOrigins:[],
      assign:function(){},replace:function(){},reload:function(){},toString:function(){return x.href}};
  }
  try{Object.defineProperty(window,"__location",{get:topLoc,set:function(){},configurable:true})}catch(e){}
})();

/* ---------- toolbar ---------- */
$("form").addEventListener("submit",function(e){
  e.preventDefault();
  var v=normalize(urlIn.value);
  if(!v||!active)return;
  navigate(active,v);
  urlIn.blur();
});
$("home").addEventListener("click",function(){if(active)navigate(active,HOME)});
$("back").addEventListener("click",function(){if(active)step(active,-1)});
$("fwd").addEventListener("click",function(){if(active)step(active,1)});
$("reload").addEventListener("click",function(){if(active)reload(active)});
$("newtab").addEventListener("click",function(){createTab(HOME,{activate:true})});
var erudaBtn=$("eruda");
if(erudaBtn){
  if(!ERUDA)erudaBtn.remove();
  else erudaBtn.addEventListener("click",function(){
    var t=active;if(!t||!t.frame)return;
    try{
      var w=t.frame.contentWindow;
      if(w.eruda){w.eruda.init();return}
      var s=w.document.createElement("script");
      s.src="https://cdn.jsdelivr.net/npm/eruda";
      s.onload=function(){w.eruda.init()};
      w.document.head.appendChild(s);
    }catch(e){toast("Eruda を開けませんでした")}
  });
}
$("debug").addEventListener("click",function(){
  var ok=false;
  try{if(typeof window.__nxDebugToggle==="function")ok=window.__nxDebugToggle()}catch(e){}
  if(!ok){window.__nxDebugPending=true;try{window.dispatchEvent(new Event("nx-open-debug"))}catch(e){}}
});
var openBtn=$("open");
function setMin(on){
  app.classList.toggle("min",on);
  syncChrome();
  try{if(on)localStorage.setItem("__nx_min","1");else localStorage.removeItem("__nx_min")}catch(e){}
}
$("min").addEventListener("click",function(){setMin(true)});
openBtn.addEventListener("click",function(e){
  if(openBtn.dataset.suppressOpen==="1"){e.preventDefault();e.stopImmediatePropagation();return}
  setMin(false);
});
(function(){
  var dragging=false,moved=false,sx=0,sy=0,bx=0,by=0,pid=null;
  function down(e){
    if(e.button!==undefined&&e.button!==0)return;
    dragging=true;moved=false;pid=e.pointerId;sx=e.clientX;sy=e.clientY;
    var r=openBtn.getBoundingClientRect();bx=r.left;by=r.top;
    e.preventDefault();e.stopPropagation();
  }
  function move(e){
    if(!dragging||(pid!==null&&e.pointerId!==pid))return;
    var dx=e.clientX-sx,dy=e.clientY-sy;
    if(!moved&&Math.hypot(dx,dy)<8)return;
    if(!moved){moved=true;openBtn.style.left=bx+"px";openBtn.style.top=by+"px";openBtn.style.right="auto";openBtn.style.bottom="auto"}
    openBtn.style.left=Math.max(0,Math.min(window.innerWidth-openBtn.offsetWidth,bx+dx))+"px";
    openBtn.style.top=Math.max(0,Math.min(window.innerHeight-openBtn.offsetHeight,by+dy))+"px";
    e.preventDefault();
  }
  function up(e){
    if(!dragging)return;
    dragging=false;pid=null;
    if(moved){openBtn.dataset.suppressOpen="1";setTimeout(function(){delete openBtn.dataset.suppressOpen},650);e.preventDefault();e.stopPropagation()}
  }
  openBtn.addEventListener("pointerdown",down,true);
  window.addEventListener("pointermove",move,true);
  window.addEventListener("pointerup",up,true);
  window.addEventListener("pointercancel",up,true);
})();
urlIn.addEventListener("blur",function(){setTimeout(function(){updateBar(true)},0)});
setInterval(function(){updateBar()},1000);

/* ---------- menu / history popup / tab sheet ---------- */
var menu=$("menu"),hmenu=$("hmenu"),sheet=$("sheet"),sheetbg=$("sheetbg");
function hidePopups(){menu.hidden=true;hmenu.hidden=true}
function showMenu(){
  hmenu.hidden=true;renderLite();renderRw();
  var r=$("more").getBoundingClientRect();
  menu.hidden=false;
  menu.style.right=Math.max(8,window.innerWidth-r.right)+"px";
  menu.style.bottom=(window.innerHeight-r.top+8)+"px";
}
$("more").addEventListener("click",function(e){e.stopPropagation();if(menu.hidden)showMenu();else hidePopups()});
menu.addEventListener("click",function(){setTimeout(hidePopups,0)});
document.addEventListener("pointerdown",function(e){
  var t=e.target;
  if(!menu.hidden&&!menu.contains(t)&&t!==$("more")&&!$("more").contains(t))menu.hidden=true;
  if(!hmenu.hidden&&!hmenu.contains(t))hmenu.hidden=true;
},true);
window.addEventListener("keydown",function(e){if(e.key==="Escape"){hidePopups();hideSheet()}});
$("m-newtab").addEventListener("click",function(){createTab(HOME,{activate:true})});
$("m-dup").addEventListener("click",function(){
  if(!active)return;
  var es=active.entries.map(function(x){return {url:x.url,doc:null}});
  createTab(null,{entries:es,idx:active.idx,activate:true});
});
$("m-closeothers").addEventListener("click",function(){
  if(!active)return;
  tabs.slice().forEach(function(t){if(t!==active)closeTab(t)});
});
$("m-copy").addEventListener("click",function(){
  var e=active&&cur(active);
  if(!e||!http(e.url)){toast("コピーできるURLがありません");return}
  function done(){toast("URL をコピーしました")}
  function fb(){try{var ta=document.createElement("textarea");ta.value=e.url;ta.setAttribute("readonly","");ta.style.cssText="position:fixed;opacity:0";document.body.appendChild(ta);ta.select();ta.setSelectionRange(0,ta.value.length);var ok=document.execCommand("copy");ta.remove();ok?done():toast("コピーできませんでした")}catch(x){toast("コピーできませんでした")}}
  try{if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(e.url).then(done,fb);else fb()}catch(x){fb()}
});
/* lightweight mode (shared flag with the home screen and the page helper) */
function liteOn(){try{return localStorage.getItem("__nx_lite")==="1"}catch(e){return false}}
function renderLite(){var b=$("m-lite"),on=liteOn();if(b)b.setAttribute("aria-checked",on?"true":"false")}
$("m-lite").addEventListener("click",function(){
  var on=!liteOn();
  try{localStorage.setItem("__nx_lite",on?"1":"0")}catch(e){}
  renderLite();
  toast("軽量モードを"+(on?"オン":"オフ")+"にしました（ホームは再読み込み、サイトは次の読み込みから反映）");
  tabs.forEach(function(t){if(isHome(cur(t).url)&&t.frame){try{t.frame.contentWindow.location.reload()}catch(e){}}});
});
renderLite();
function renderRw(){var b=$("m-rw"),note=$("m-rw-note"),e=active&&cur(active),valid=!!(e&&http(e.url));if(b){b.disabled=!valid;b.setAttribute("aria-checked",valid&&useRw(e.url)?"true":"false")}if(note)note.textContent=valid?hostOf(e.url):"サイトを開くと切り替えできます"}
$("m-rw").addEventListener("click",function(){
  var t=active,e=t&&cur(t);
  if(!e||!http(e.url)){toast("サイトを開いてから切り替えてください");return}
  var host=new URL(e.url).hostname.replace(/^www\./,"").toLowerCase(),list=rwList(),on=useRw(e.url);
  if(on)list=list.filter(function(d){return !(host===d||host.endsWith("."+d))});
  else list.push(host);
  try{localStorage.setItem("__nx_rwhosts",JSON.stringify(list))}catch(x){}
  syncRwToSw();
  toast(host+" の互換モードを"+(on?"オフ":"オン")+"にしました。再読み込みします");
  t.expect="restore";loadFrame(t,e.url,true);
});
/* long-press back / forward = history list of this tab */
function jump(t,i){
  if(i<0||i>=t.entries.length||i===t.idx)return;
  t.idx=i;t.expect="restore";loadFrame(t,t.entries[i].url,true);onChange(t);
}
function showHist(dir,btn){
  var t=active;if(!t)return;
  menu.hidden=true;hmenu.textContent="";
  var list=[],i;
  if(dir<0){for(i=t.idx-1;i>=0&&list.length<12;i--)list.push(i)}
  else{for(i=t.idx+1;i<t.entries.length&&list.length<12;i++)list.push(i)}
  if(!list.length)return;
  list.forEach(function(ix){
    var e=t.entries[ix],b=document.createElement("button");b.type="button";b.className="mi";
    var tx=document.createElement("span");tx.className="tx";
    var s1=document.createElement("span");s1.textContent=isHome(e.url)?"ホーム":hostOf(e.url).replace(/^www\./,"");
    var s2=document.createElement("small");
    try{var u=new URL(e.url);s2.textContent=isHome(e.url)?"スタートページ":(u.pathname+u.search).slice(0,70)||"/"}catch(x){s2.textContent=""}
    tx.appendChild(s1);tx.appendChild(s2);b.appendChild(tx);
    b.addEventListener("click",function(){hmenu.hidden=true;jump(t,ix)});
    hmenu.appendChild(b);
  });
  var r=btn.getBoundingClientRect();
  hmenu.hidden=false;
  hmenu.style.left=Math.max(8,Math.min(window.innerWidth-hmenu.offsetWidth-8,r.left))+"px";
  hmenu.style.bottom=(window.innerHeight-r.top+8)+"px";
}
function longPress(btn,fn){
  var timer=0,fired=false;
  btn.addEventListener("pointerdown",function(){fired=false;clearTimeout(timer);timer=setTimeout(function(){fired=true;fn()},480)});
  ["pointerup","pointerleave","pointercancel"].forEach(function(ev){btn.addEventListener(ev,function(){clearTimeout(timer)})});
  btn.addEventListener("click",function(e){if(fired){e.preventDefault();e.stopImmediatePropagation();fired=false}},true);
  btn.addEventListener("contextmenu",function(e){e.preventDefault()});
}
longPress($("back"),function(){showHist(-1,$("back"))});
longPress($("fwd"),function(){showHist(1,$("fwd"))});
/* tab sheet */
function renderSheet(){
  var l=$("sh-list");l.textContent="";
  tabs.forEach(function(t){
    var e=cur(t),row=document.createElement("div");row.className="sh-row"+(t===active?" on":"");
    var bd=document.createElement("span");setBadge(bd,badge(e.url));
    var tx=document.createElement("span");tx.className="sh-tx";
    var a=document.createElement("b");a.textContent=isHome(e.url)?"ホーム":hostOf(e.url).replace(/^www\./,"");
    var s=document.createElement("small");s.textContent=isHome(e.url)?"スタートページ":(t.title||e.url);
    tx.appendChild(a);tx.appendChild(s);
    var x=document.createElement("button");x.type="button";x.className="sh-x";x.innerHTML=ICON_X;x.setAttribute("aria-label","タブを閉じる");
    row.appendChild(bd);row.appendChild(tx);row.appendChild(x);
    row.addEventListener("click",function(ev){
      if(ev.target===x||x.contains(ev.target)){closeTab(t);renderSheet();return}
      activate(t);hideSheet();
    });
    l.appendChild(row);
  });
}
function showSheet(){
  hidePopups();renderSheet();
  sheetbg.hidden=false;sheet.hidden=false;
  requestAnimationFrame(function(){requestAnimationFrame(function(){sheetbg.classList.add("show");sheet.classList.add("show")})});
}
function hideSheet(){
  if(sheet.hidden)return;
  sheetbg.classList.remove("show");sheet.classList.remove("show");
  setTimeout(function(){sheet.hidden=true;sheetbg.hidden=true},230);
}
$("tabsbtn").addEventListener("click",showSheet);
sheetbg.addEventListener("click",hideSheet);
$("sh-new").addEventListener("click",function(){createTab(HOME,{activate:true});hideSheet()});
urlIn.addEventListener("focus",function(){setTimeout(function(){try{urlIn.select()}catch(e){}},0)});

/* ---------- session restore banner ---------- */
function showBanner(s){
  savedForBanner=s;holdSave=true;
  var n=s.tabs.filter(function(t){var e=t.entries&&t.entries[t.idx];return e&&http(e.url)}).length;
  $("bannertx").textContent="前回のタブ "+n+" 件を復元できます";
  bannerEl.hidden=false;
  /* appear together with the home screen's own staggered reveal, never over the opening animation */
  if(homeIsReady||!(active&&isHome(cur(active).url)))revealBanner();
  else{bannerWait=true;setTimeout(function(){if(bannerWait){bannerWait=false;revealBanner()}},7500)}
}
var homeIsReady=false,bannerWait=false;
function revealBanner(){requestAnimationFrame(function(){bannerEl.classList.add("show")})}
function onHomeReady(){homeIsReady=true;if(bannerWait){bannerWait=false;revealBanner()}}
function hideBanner(){bannerEl.classList.remove("show");bannerEl.hidden=true;bannerWait=false;holdSave=false;savedForBanner=null;save()}
$("b-no").addEventListener("click",hideBanner);
$("b-ok").addEventListener("click",function(){
  var s=savedForBanner;if(!s)return hideBanner();
  tabs.slice().forEach(function(t){if(t.frame){try{t.frame.src="about:blank"}catch(e){}t.frame.remove()}t.el.remove()});
  tabs.length=0;active=null;
  s.tabs.slice(0,MAXTABS).forEach(function(st,i){
    var es=(st.entries||[]).filter(function(e){return e&&(e.url===HOME||http(e.url))}).map(function(e){return {url:clean(e.url),doc:null}});
    if(!es.length)es=[{url:HOME,doc:null}];
    createTab(null,{entries:es,idx:Math.min(Math.max(0,st.idx|0),es.length-1),lazy:true});
  });
  var a=tabs[Math.min(Math.max(0,s.active|0),tabs.length-1)]||tabs[0];
  hideBanner();
  activate(a);
});

/* ---------- boot ---------- */
function start(){
  syncRwToSw();
  try{navigator.serviceWorker.addEventListener("controllerchange",syncRwToSw)}catch(e){}
  var saved=loadSaved(),opened=false;
  var m=/^#open=(.+)$/.exec(location.hash);
  if(m){
    try{
      var raw=decodeURIComponent(m[1]);
      var real=raw.indexOf("rw:")===0?nxRwUnwrapRest(raw.slice(3)):nxUnwrapRest(raw);
      if(real&&http(real)){createTab(real,{activate:true});opened=true}
    }catch(e){}
    try{history.replaceState(null,"",location.pathname)}catch(e){}
  }
  if(!opened)createTab(HOME,{activate:true});
  if(!opened&&saved&&meaningful(saved))showBanner(saved);
  try{if(localStorage.getItem("__nx_min")==="1")app.classList.add("min")}catch(e){}
  syncChrome();
  $("boot").remove();
}
if(!("serviceWorker" in navigator)){
  $("boot").textContent="このブラウザ（またはモード）は Service Worker に対応していないため、Nexora を使えません。";
}else{
  navigator.serviceWorker.register(P_SW,{scope:"/"}).then(function(){return navigator.serviceWorker.ready}).then(start).catch(function(err){
    $("boot").textContent="準備できませんでした: "+err;
  });
}
})();
`;

function buildShell() {
  const js = SHELL_JS
    .split("@@PSTART@@").join(JSON.stringify(P_START))
    .split("@@PSW@@").join(JSON.stringify(P_SW))
    .split("@@SEARCH@@").join(JSON.stringify(SEARCH_BASE))
    .split("@@ERUDA@@").join(JSON.stringify(ENABLE_ERUDA))
    .split("@@RWDEF@@").join(JSON.stringify(RW_DEFAULT_HOSTS))
    .split("@@COMMUNITY@@").join(JSON.stringify(COMMUNITY_HUB + P_COMMUNITY));
  return `<!doctype html>
<html lang="ja" data-nx-shell>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Nexora</title>
<link rel="icon" href="/favicon.ico?v=${NEXORA_VERSION}" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=${NEXORA_VERSION}">
<style>
:root{--bg:#0f0c29;--panel:rgba(17,15,37,.97);--line:rgba(255,255,255,.09);--acc:#8b7bff;--acc2:#a58aff;--txt:#e8eaed;--dim:#9aa0b6}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{height:100%;overflow:hidden;overscroll-behavior:none;background:var(--bg);color:var(--txt);font:13px/1.35 system-ui,-apple-system,"Segoe UI","Hiragino Sans",sans-serif;-webkit-text-size-adjust:100%}
button{font:inherit;color:inherit}
svg{display:block;fill:none;stroke:currentColor;stroke-width:2.1;stroke-linecap:round;stroke-linejoin:round}
#app{position:fixed;inset:0;display:flex;flex-direction:column;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e)}
/* ---- tab strip ---- */
#tabs{position:relative;flex:none;display:flex;align-items:center;gap:8px;padding:calc(7px + env(safe-area-inset-top,0px)) 10px 7px;background:var(--panel);border-bottom:1px solid var(--line)}
#tabs{transition:padding .3s cubic-bezier(.22,1,.36,1),border-color .3s}
#tabl{flex:1;min-width:0;display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch;padding:1px 0}
#tabl::-webkit-scrollbar{display:none}
.tab{flex:0 1 172px;min-width:104px;display:flex;align-items:center;gap:8px;height:34px;padding:0 5px 0 7px;border:1px solid var(--line);border-radius:12px;background:rgba(255,255,255,.04);color:var(--dim);cursor:pointer;user-select:none;-webkit-user-select:none;transition:background .2s,border-color .2s,color .2s,box-shadow .2s,transform .15s}
.tab:active{transform:scale(.97)}
.tab.on{background:linear-gradient(135deg,rgba(102,126,234,.30),rgba(118,75,162,.30));border-color:rgba(166,139,255,.65);color:#fff;box-shadow:0 0 0 1px rgba(139,123,255,.12),0 4px 14px rgba(80,60,180,.28)}
.bd{flex:none;position:relative;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font:700 11px/1 system-ui;color:#fff;background:hsl(var(--h,260) 52% 46%)}
.bd.home{background:linear-gradient(135deg,#667eea,#764ba2)}
.tab.loading .bd{color:transparent}
.tab.loading .bd::after{content:"";position:absolute;inset:-3px;border-radius:50%;border:2px solid transparent;border-top-color:#fff;animation:nxspin .8s linear infinite}
.tab .lab{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px}
.tab .x{flex:none;appearance:none;border:0;background:transparent;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;cursor:pointer;opacity:.6;transition:background .15s,opacity .15s}
.tab .x:hover{background:rgba(255,255,255,.14);opacity:1}
.tab .x svg{width:10px;height:10px;stroke-width:2.6}
@media (hover:none){.tab:not(.on) .x{display:none}.tab{min-width:92px}}
.tbtn{flex:none;position:relative;appearance:none;border:1px solid var(--line);background:rgba(255,255,255,.05);width:36px;height:34px;border-radius:12px;display:grid;place-items:center;cursor:pointer;color:#d8dcf0;transition:background .15s,transform .12s}
.tbtn:hover{background:rgba(255,255,255,.11)}
.tbtn:active{transform:scale(.94)}
.tbtn svg{width:16px;height:16px}
#tabl{max-height:40px}
#tabl,#newtab{transition:max-height .3s cubic-bezier(.22,1,.36,1),height .3s cubic-bezier(.22,1,.36,1),opacity .2s ease,padding .3s,border-width .3s}
/* ページを開いている間は上のタブ列を畳む(ノッチ分の余白だけ残す) */
#app:not(.nobar) #tabs{padding-top:env(safe-area-inset-top,0px);padding-bottom:0;border-bottom-color:transparent}
#app:not(.nobar) #tabl{max-height:0;opacity:0;padding:0;pointer-events:none}
#app:not(.nobar) #newtab{height:0;opacity:0;padding:0;border-width:0;overflow:hidden;pointer-events:none}

#loadbar{position:absolute;left:0;right:0;bottom:-1px;height:2px;overflow:hidden;opacity:0;transition:opacity .25s;pointer-events:none}
#loadbar.on{opacity:1}
#loadbar::before{content:"";position:absolute;top:0;bottom:0;width:38%;background:linear-gradient(90deg,transparent,#a58aff,#fff,#a58aff,transparent);animation:nxload 1.1s ease-in-out infinite}
@keyframes nxload{from{left:-40%}to{left:102%}}
@keyframes nxspin{to{transform:rotate(360deg)}}
/* ---- stage ---- */
#stage{flex:1;min-height:0;position:relative}
.tf{position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff;visibility:hidden;pointer-events:none}
.tf.on{visibility:visible;pointer-events:auto}
#boot{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;color:var(--dim);z-index:3}
/* ---- bottom toolbar ---- */
#bar{flex:none;display:grid;grid-template-rows:1fr;background:var(--panel);border-top:1px solid var(--line);box-shadow:0 -6px 24px rgba(0,0,0,.35);transition:grid-template-rows .3s cubic-bezier(.22,1,.36,1),opacity .22s ease .05s,border-top-width .3s,box-shadow .3s,visibility 0s}
#barin{min-height:0;overflow:hidden}
#app.min #bar,#app.nobar #bar{grid-template-rows:0fr;opacity:0;border-top-width:0;box-shadow:none;visibility:hidden;pointer-events:none;transition:grid-template-rows .3s cubic-bezier(.22,1,.36,1),opacity .18s ease,border-top-width .3s,box-shadow .3s,visibility 0s linear .3s}
#form{display:flex;flex-direction:column;gap:6px;padding:8px 10px calc(8px + env(safe-area-inset-bottom,0px))}
#btnrow{display:flex;align-items:center;justify-content:space-between;gap:2px}
.ibtn{flex:1 1 0;position:relative;appearance:none;border:0;background:transparent;height:44px;border-radius:12px;display:grid;place-items:center;color:#cfd3ea;cursor:pointer;transition:background .15s,transform .12s,opacity .15s;-webkit-touch-callout:none;user-select:none;-webkit-user-select:none}
.ibtn:hover{background:rgba(255,255,255,.08)}
.ibtn:active{transform:scale(.9);background:rgba(255,255,255,.12)}
.ibtn:disabled{opacity:.28;cursor:default;transform:none;background:transparent}
.ibtn svg{width:22px;height:22px}
#reload.spin svg{animation:nxspin .8s linear infinite}
#tabcount{position:absolute;inset:0;display:grid;place-items:center;font:700 10px/1 system-ui;padding-top:2px;pointer-events:none}
#urlwrap{position:relative;display:flex;align-items:center;gap:8px;height:42px;padding:0 5px 0 12px;border-radius:14px;background:rgba(255,255,255,.07);border:1px solid var(--line);transition:border-color .2s,box-shadow .2s,background .2s}
#urlwrap:focus-within{border-color:var(--acc);background:rgba(255,255,255,.1);box-shadow:0 0 0 3px rgba(139,123,255,.22)}
#urlicon{flex:none;width:16px;height:16px;color:var(--dim)}
#urlicon svg{width:16px;height:16px;display:none}
#urlicon[data-s="h"] .i-s,#urlicon[data-s="s"] .i-l,#urlicon[data-s="i"] .i-w{display:block}
#urlicon[data-s="s"]{color:#7ddc9a}#urlicon[data-s="i"]{color:#f2c46d}
#url{flex:1;min-width:0;height:100%;background:none;border:0;outline:0;color:var(--txt);font:15px system-ui,-apple-system,"Segoe UI",sans-serif}
#url::placeholder{color:var(--dim)}
#url:not(:focus){color:transparent;caret-color:transparent}
#urlview{position:absolute;left:36px;right:46px;top:0;bottom:0;display:flex;align-items:center;gap:0;overflow:hidden;white-space:nowrap;font-size:15px;pointer-events:none}
#urlview b{font-weight:600;color:var(--txt)}
#urlview span{color:var(--dim);overflow:hidden;text-overflow:ellipsis;min-width:0}
#urlwrap:focus-within #urlview{display:none}
#go{flex:none;appearance:none;border:0;width:34px;height:32px;border-radius:10px;display:grid;place-items:center;cursor:pointer;color:#fff;background:linear-gradient(135deg,#667eea,#764ba2);transition:transform .12s,opacity .15s}
#go svg{width:17px;height:17px;stroke-width:2.4}
#go:active{transform:scale(.92)}
@media (hover:none),(max-width:640px){#url{font-size:16px}}
@media (min-width:720px){
  #form{flex-direction:row;align-items:center;gap:6px}
  #btnrow{display:contents}
  .ibtn{flex:none;width:42px;height:42px}
  #back{order:1}#fwd{order:2}#home{order:3}#reload{order:4}
  #urlrow{order:5;flex:1;min-width:0}
  #tabsbtn{order:6}#more{order:7}
}
/* ---- popup menu / history list ---- */
#menu,#hmenu{position:fixed;z-index:30;min-width:210px;max-width:min(86vw,340px);max-height:60vh;overflow:auto;padding:6px;border-radius:16px;background:rgba(20,18,44,.98);border:1px solid rgba(255,255,255,.13);box-shadow:0 18px 50px rgba(0,0,0,.55);transform-origin:bottom right;animation:nxpop .14s ease-out}
#hmenu{transform-origin:bottom left}
#menu[hidden],#hmenu[hidden]{display:none}
@keyframes nxpop{from{opacity:0;transform:scale(.94) translateY(6px)}to{opacity:1;transform:none}}
.mi{display:flex;align-items:center;gap:12px;width:100%;appearance:none;border:0;background:transparent;text-align:left;padding:11px 12px;border-radius:11px;font-size:14px;color:var(--txt);cursor:pointer}
.mi:hover,.mi:active{background:rgba(255,255,255,.09)}
.mi svg{flex:none;width:18px;height:18px;color:var(--acc2)}
.mi small{display:block;color:var(--dim);font-size:11.5px;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mi .tx{min-width:0;flex:1;overflow:hidden}
.m-setting{padding:3px 0}
.m-setting+.m-setting{border-top:1px solid rgba(255,255,255,.09);margin-top:4px;padding-top:7px}
.m-setting .mi{gap:10px;padding:9px 10px;cursor:pointer}
.m-setting .mi:disabled{opacity:.48;cursor:default}
.m-setting .mi .tx{display:block;white-space:normal;overflow:visible}
.m-setting .mi .tx b{display:block;font-size:13px;font-weight:600;line-height:1.35}
.m-setting .mi .tx small{display:block;white-space:normal;line-height:1.4;margin-top:3px;font-size:11px;color:var(--dim)}
.m-switch{flex:none;width:36px;height:21px;border-radius:20px;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.16);padding:2px;transition:background .18s,border-color .18s}
.m-switch i{display:block;width:15px;height:15px;border-radius:50%;background:#d8d6e7;transition:transform .18s,background .18s}
.m-setting .mi[aria-checked="true"] .m-switch{background:#7657df;border-color:#9a82ff}
.m-setting .mi[aria-checked="true"] .m-switch i{transform:translateX(15px);background:#fff}
.m-setting-note{display:block;padding:0 12px 4px 40px;color:var(--dim);font-size:10.5px;line-height:1.35}
.msep{height:1px;margin:5px 8px;background:var(--line)}
/* ---- tab sheet ---- */
#sheetbg{position:fixed;inset:0;z-index:40;background:rgba(5,4,16,.55);opacity:0;transition:opacity .2s}
#sheetbg.show{opacity:1}
#sheet{position:fixed;left:0;right:0;bottom:0;z-index:41;max-height:78vh;display:flex;flex-direction:column;border-radius:22px 22px 0 0;background:rgba(20,18,44,.99);border-top:1px solid rgba(255,255,255,.14);box-shadow:0 -16px 50px rgba(0,0,0,.5);padding-bottom:env(safe-area-inset-bottom,0px);transform:translateY(100%);transition:transform .24s cubic-bezier(.22,1,.36,1);max-width:640px;margin:0 auto}
#sheet.show{transform:none}
#sheetbg[hidden],#sheet[hidden]{display:none}
.grab{width:42px;height:4px;border-radius:2px;background:rgba(255,255,255,.22);margin:9px auto 4px}
.sh-head{display:flex;align-items:center;justify-content:space-between;padding:6px 16px 10px}
.sh-head b{font-size:16px}
#sh-new{appearance:none;border:0;display:flex;align-items:center;gap:6px;padding:8px 14px;border-radius:12px;font-size:13px;font-weight:600;color:#fff;background:linear-gradient(135deg,#667eea,#764ba2);cursor:pointer}
#sh-new svg{width:15px;height:15px;stroke-width:2.6}
#sh-list{overflow:auto;-webkit-overflow-scrolling:touch;padding:2px 10px 12px;display:flex;flex-direction:column;gap:6px}
.sh-row{display:flex;align-items:center;gap:12px;padding:10px 10px 10px 12px;border-radius:14px;border:1px solid var(--line);background:rgba(255,255,255,.04);cursor:pointer}
.sh-row.on{border-color:rgba(166,139,255,.65);background:linear-gradient(135deg,rgba(102,126,234,.22),rgba(118,75,162,.22))}
.sh-row .bd{width:28px;height:28px;font-size:13px}
.sh-tx{flex:1;min-width:0;display:flex;flex-direction:column}
.sh-tx b{font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sh-tx small{color:var(--dim);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sh-x{flex:none;appearance:none;border:0;width:34px;height:34px;border-radius:50%;display:grid;place-items:center;background:rgba(255,255,255,.07);color:#cfd3ea;cursor:pointer}
.sh-x svg{width:13px;height:13px;stroke-width:2.6}
/* ---- banner / toast / floating button ---- */
#banner{position:absolute;left:50%;transform:translateX(-50%) translateY(-8px);opacity:0;pointer-events:none;transition:opacity .6s ease .15s,transform .7s cubic-bezier(.22,1,.36,1) .15s;top:calc(60px + env(safe-area-inset-top,0px));z-index:5;display:flex;align-items:center;gap:10px;padding:10px 12px 10px 16px;border:1px solid rgba(166,139,255,.5);border-radius:14px;background:rgba(14,12,38,.97);box-shadow:0 10px 30px rgba(0,0,0,.45);font-size:13px;max-width:92vw}
#banner[hidden]{display:none}
#banner.show{opacity:1;pointer-events:auto;transform:translateX(-50%)}
#banner button{appearance:none;border:0;border-radius:10px;padding:7px 14px;font-weight:600;font-size:12.5px;cursor:pointer;color:#fff;background:linear-gradient(135deg,#667eea,#764ba2)}
#banner #b-no{background:rgba(255,255,255,.08);padding:7px 10px;color:var(--dim)}
#toast{position:fixed;left:50%;bottom:calc(88px + env(safe-area-inset-bottom,0px));transform:translateX(-50%) translateY(8px);z-index:60;padding:9px 16px;border-radius:12px;background:rgba(14,12,38,.96);border:1px solid rgba(255,255,255,.15);font-size:12.5px;opacity:0;pointer-events:none;transition:opacity .25s,transform .25s}
#toast.show{opacity:1;transform:translateX(-50%)}
#open{display:none;position:fixed;left:10px;bottom:calc(10px + env(safe-area-inset-bottom,0px));z-index:2147483647;width:46px;height:46px;padding:0;border-radius:50%;align-items:center;justify-content:center;font-size:20px;background:rgba(102,126,234,.98);color:#fff;border:1px solid rgba(255,255,255,.65);box-shadow:0 0 0 2px rgba(102,126,234,.35),0 0 22px rgba(102,126,234,.9),0 4px 14px rgba(0,0,0,.5);touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;cursor:grab}
#open{animation:nxopen .38s cubic-bezier(.22,1,.36,1) .18s backwards}
@keyframes nxopen{from{opacity:0;transform:scale(.3) translateY(14px)}to{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){*{animation-duration:.01ms!important;transition-duration:.01ms!important}}

</style>
</head>
<body>
<div id="app" class="nobar">
  <div id="tabs">
    <div id="tabl"></div>
    <button id="newtab" class="tbtn" type="button" aria-label="新しいタブ" title="新しいタブ"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>
    <div id="loadbar"></div>
  </div>
  <div id="stage"><div id="boot">準備中…</div></div>
  <div id="banner" hidden><span id="bannertx"></span><button id="b-ok" type="button">復元</button><button id="b-no" type="button" aria-label="閉じる">✕</button></div>
  <div id="bar"><div id="barin"><form id="form" autocomplete="off">
    <div id="urlrow">
      <div id="urlwrap">
        <span id="urlicon" data-s="h">
          <svg class="i-s" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg>
          <svg class="i-l" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2.2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>
          <svg class="i-w" viewBox="0 0 24 24"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.4"/></svg>
        </span>
        <input id="url" type="text" spellcheck="false" inputmode="url" enterkeyhint="go" autocapitalize="off" autocorrect="off" placeholder="検索またはURLを入力">
        <div id="urlview"><b id="uvhost"></b><span id="uvpath"></span></div>
        <button id="go" type="submit" aria-label="移動"><svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>
      </div>
    </div>
    <div id="btnrow">
      <button id="back" class="ibtn" type="button" title="戻る(長押しで履歴)" aria-label="戻る" disabled><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
      <button id="fwd" class="ibtn" type="button" title="進む(長押しで履歴)" aria-label="進む" disabled><svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button>
      <button id="home" class="ibtn" type="button" title="ホーム" aria-label="ホーム"><svg viewBox="0 0 24 24"><path d="M4 11l8-7 8 7v8.2a.8.8 0 0 1-.8.8H15v-6H9v6H4.8a.8.8 0 0 1-.8-.8z"/></svg></button>
      <button id="reload" class="ibtn" type="button" title="再読み込み" aria-label="再読み込み"><svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.4 5.7"/><path d="M20 4.5V11h-6.5"/></svg></button>
      <button id="tabsbtn" class="ibtn" type="button" title="タブ一覧" aria-label="タブ一覧"><svg viewBox="0 0 24 24"><rect x="4" y="6" width="16" height="14" rx="3.2"/><path d="M8.5 3h7"/></svg><span id="tabcount">1</span></button>
      <button id="more" class="ibtn" type="button" title="メニュー" aria-label="メニュー"><svg viewBox="0 0 24 24"><circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/></svg></button>
    </div>
  </form></div></div>
  <div id="menu" hidden>
    <button class="mi" id="m-newtab" type="button"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>新しいタブ</button>
    <button class="mi" id="m-dup" type="button"><svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8"/></svg>タブを複製</button>
    <button class="mi" id="m-copy" type="button"><svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>URLをコピー</button>
    <button class="mi" id="m-closeothers" type="button"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>他のタブを閉じる</button>
    <div class="msep"></div>
    <button class="mi" id="eruda" type="button"><svg viewBox="0 0 24 24"><path d="M14.7 6.3a4 4 0 0 0-5 5L4 17l3 3 5.7-5.7a4 4 0 0 0 5-5l-2.7 2.7-2.3-.7-.7-2.3z"/></svg>Eruda コンソール</button>
    <button class="mi" id="debug" type="button"><svg viewBox="0 0 24 24"><path d="M3 12h4l2.5-7 5 14 2.5-7h4"/></svg>Debug Panel</button>
    <div class="m-setting">
      <button class="mi" id="m-lite" type="button" role="switch" aria-checked="false">
        <svg viewBox="0 0 24 24"><path d="M13 3L5 14h6l-1 7 8-11h-6z"/></svg>
        <span class="tx"><b>軽量モード</b><small>演出や一部の監視処理を抑えて、動作を軽くします。</small></span>
        <span class="m-switch" aria-hidden="true"><i></i></span>
      </button>
    </div>
    <div class="m-setting">
      <button class="mi" id="m-rw" type="button" role="switch" aria-checked="false" disabled>
        <svg viewBox="0 0 24 24"><path d="M4 7h11M4 7l3-3M4 7l3 3M20 17H9M20 17l-3-3M20 17l-3 3"/></svg>
        <span class="tx"><b>互換モード</b><small>サイトが正常に開かない・表示が崩れる場合に試してください。</small></span>
        <span class="m-switch" aria-hidden="true"><i></i></span>
      </button>
      <small class="m-setting-note" id="m-rw-note">サイトを開くと切り替えできます</small>
    </div>
    <button class="mi" id="min" type="button"><svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg>バーを隠す</button>
  </div>
  <div id="hmenu" hidden></div>
</div>
<div id="sheetbg" hidden></div>
<div id="sheet" hidden>
  <div class="grab"></div>
  <div class="sh-head"><b>タブ</b><button id="sh-new" type="button"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>新しいタブ</button></div>
  <div id="sh-list"></div>
</div>
<div id="toast"></div>
<button id="open" type="button" title="バーを開く" aria-label="バーを開く">☰</button>

${DEBUG_UI_HTML}
<script>
var NX_KEY=${JSON.stringify(NX_KEY)};
${CODEC_SRC}
</script>
<script>
${js}
</script>
</body>
</html>`;
}


function buildLanding(opts) {
  const framed = !!(opts && opts.framed);
  const link = (u) => nxWrapUrl("", u);
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nexora</title>
<link rel="icon" href="/favicon.ico?v=${NEXORA_VERSION}" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=${NEXORA_VERSION}">
<script>try{if(localStorage.getItem("__nx_lite")==="1")document.documentElement.classList.add("nx-lite")}catch(e){}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html{overscroll-behavior:none}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);color:#fff;overscroll-behavior:none;overflow-x:hidden}
.c{text-align:center;padding:40px 20px;width:100%;max-width:560px;position:relative;z-index:1}
/* Nexora title interstitial — stage 2 */
#nx-title-stage{position:fixed;inset:0;z-index:999998;display:flex;align-items:center;justify-content:center;overflow:hidden;opacity:0;visibility:hidden;pointer-events:none;background:#05060b;transition:opacity .35s ease,background .82s ease,visibility 0s linear .35s}
#nx-title-stage::before,#nx-title-stage::after{content:"";position:absolute;left:0;width:100%;height:50%;background:#05060b;z-index:1;transition:transform .82s cubic-bezier(.22,1,.36,1)}
#nx-title-stage::before{top:0}#nx-title-stage::after{bottom:0}
#nx-title-stage.show{opacity:1;visibility:visible;transition:opacity .45s ease,visibility 0s}
#nx-title-stage.leave{background:transparent}#nx-title-stage.leave::before{transform:translateY(-102%)}#nx-title-stage.leave::after{transform:translateY(102%)}
#nx-title-stage .nx-title-content{position:relative;z-index:2;text-align:center;transform:translateY(12px) scale(.97);opacity:0;transition:opacity .75s ease .12s,transform .9s cubic-bezier(.22,1,.36,1) .12s;padding:24px}
#nx-title-stage.show .nx-title-content{opacity:1;transform:none}
#nx-title-stage.leave .nx-title-content{opacity:0;transform:translateY(-8px) scale(1.025);transition:opacity .28s ease,transform .35s ease}
#nx-title-stage .nx-title-name{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:clamp(2.1rem,8vw,4.4rem);font-weight:650;letter-spacing:.19em;padding-left:.19em;line-height:1.1;color:#f7f6ff;text-shadow:0 0 22px rgba(153,126,255,.22);white-space:nowrap}
#nx-title-stage .nx-title-name::after{content:"";display:block;height:1px;width:min(62%,280px);margin:17px auto 13px;background:linear-gradient(90deg,transparent,rgba(175,151,255,.85),rgba(255,255,255,.95),rgba(175,151,255,.85),transparent);transform:scaleX(0);transform-origin:center;animation:nxTitleLine 1s cubic-bezier(.22,1,.36,1) .35s forwards;filter:drop-shadow(0 0 5px rgba(153,126,255,.8))}
#nx-title-stage .nx-title-byline{font-size:clamp(.72rem,2.5vw,.9rem);font-weight:400;letter-spacing:.22em;color:rgba(205,199,231,.68);opacity:0;transform:translateY(7px);animation:nxTitleByline .7s ease .55s forwards}
#nx-title-stage .nx-title-glow{position:absolute;width:min(76vw,560px);aspect-ratio:1;border-radius:50%;background:radial-gradient(circle,rgba(107,76,220,.12),rgba(60,74,155,.035) 38%,transparent 70%);filter:blur(15px);pointer-events:none;animation:nxTitleGlow 3.4s ease-in-out infinite}
@keyframes nxTitleLine{to{transform:scaleX(1)}}@keyframes nxTitleByline{to{opacity:1;transform:none}}@keyframes nxTitleGlow{0%,100%{opacity:.55;transform:scale(.94)}50%{opacity:1;transform:scale(1.06)}}
@media(prefers-reduced-motion:reduce){#nx-title-stage *,#nx-title-stage::before,#nx-title-stage::after{animation-duration:.01ms!important;transition-duration:.01ms!important}}
#nexora-loader{position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;background:transparent;opacity:1;pointer-events:auto;overflow:hidden}
#nexora-loader::before,#nexora-loader::after{content:"";position:absolute;left:0;width:100%;height:50%;background:#000;z-index:1;transition:transform .8s cubic-bezier(.22,1,.36,1)}
#nexora-loader::before{top:0}
#nexora-loader::after{bottom:0}
.nx-aura{position:absolute;width:260px;height:260px;border-radius:50%;background:radial-gradient(circle,rgba(125,80,255,.11) 0%,rgba(125,80,255,.035) 35%,transparent 70%);filter:blur(24px);animation:aura 5s ease-in-out infinite}
@keyframes aura{0%,100%{transform:scale(.92);opacity:.55}50%{transform:scale(1.08);opacity:.9}}
.nx-orbit{position:absolute;width:310px;height:112px;border:1px solid rgba(190,170,255,.22);border-radius:50%;transform:rotate(-17deg) scaleY(.82);animation:orbitReveal 2.8s cubic-bezier(.22,1,.36,1) forwards,orbitMove 12s linear 2.8s infinite}
@keyframes orbitReveal{from{opacity:0;clip-path:inset(0 50% 0 50%)}to{opacity:1;clip-path:inset(0 0 0 0)}}
@keyframes orbitMove{from{transform:rotate(-17deg) scaleY(.82) rotate(0deg)}to{transform:rotate(-17deg) scaleY(.82) rotate(360deg)}}
.nx-orbit::after{content:"";position:absolute;width:70px;height:1px;left:42%;top:-1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.9),transparent);filter:drop-shadow(0 0 5px rgba(150,110,255,.8));animation:orbitLight 3.8s ease-in-out infinite}
@keyframes orbitLight{0%{transform:translateX(-80px);opacity:0}25%{opacity:1}75%{opacity:1}100%{transform:translateX(80px);opacity:0}}
.nx-orbit2{position:absolute;width:245px;height:88px;border:1px solid rgba(150,120,220,.08);border-radius:50%;transform:rotate(58deg) scaleY(.82);opacity:0;animation:orbit2In 2.5s ease 1s forwards,orbit2Move 16s linear 3.5s infinite reverse}
@keyframes orbit2In{to{opacity:1}}
@keyframes orbit2Move{from{transform:rotate(58deg) scaleY(.82) rotate(0)}to{transform:rotate(58deg) scaleY(.82) rotate(360deg)}}
.nx-logo{position:relative;z-index:10;width:150px;height:150px;opacity:0;animation:logoAppear 1.8s cubic-bezier(.22,1,.36,1) .25s forwards,logoFloat 6s ease-in-out 2s infinite}
@keyframes logoAppear{0%{opacity:0;transform:scale(.82);filter:blur(7px) brightness(1)}60%{opacity:1;transform:scale(1.015);filter:blur(0) brightness(1.15)}100%{opacity:1;transform:scale(1);filter:blur(0) brightness(1)}}
@keyframes logoFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
.nx-logo svg{width:100%;height:100%;overflow:visible;filter:drop-shadow(0 0 4px rgba(255,255,255,.45)) drop-shadow(0 0 20px rgba(110,70,255,.16))}
.nx-n{fill:none;stroke:#f7f7fa;stroke-width:6;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:420;stroke-dashoffset:420;animation:drawN 1.65s cubic-bezier(.65,0,.35,1) .15s forwards}
@keyframes drawN{to{stroke-dashoffset:0}}
.nx-sweep{fill:none;stroke:rgba(255,255,255,.82);stroke-width:1.2;stroke-dasharray:180;stroke-dashoffset:180;animation:sweepIn 1.7s cubic-bezier(.65,0,.35,1) .65s forwards,sweepGlow 4s ease-in-out 2.5s infinite}
@keyframes sweepIn{to{stroke-dashoffset:0}}
@keyframes sweepGlow{0%,100%{opacity:.55}50%{opacity:1}}
.nx-star{fill:#fff;opacity:0;filter:drop-shadow(0 0 4px #fff) drop-shadow(0 0 9px rgba(130,90,255,.8));animation:starAppear .8s ease 1.45s forwards,starPulse 3s ease-in-out 2.2s infinite}
@keyframes starAppear{from{opacity:0;transform:scale(.3)}to{opacity:.9;transform:scale(1)}}
@keyframes starPulse{0%,100%{opacity:.55}50%{opacity:1}}
.nx-flash{position:absolute;width:1px;height:100px;background:linear-gradient(to bottom,transparent,rgba(255,255,255,.55),transparent);opacity:0;transform:rotate(90deg);animation:flash 2.5s ease 1.2s forwards}
@keyframes flash{0%{opacity:0;transform:rotate(90deg) scaleX(.2)}40%{opacity:.35}70%{opacity:0;transform:rotate(90deg) scaleX(1)}100%{opacity:0}}

/* Premium Nexora intro frame — decorative layers only */
.nx-premium-grid,.nx-premium-frame,.nx-premium-corner,.nx-premium-label,.nx-premium-beam{position:absolute;pointer-events:none;z-index:3}
.nx-premium-grid{inset:0;opacity:0;background-image:linear-gradient(rgba(154,126,255,.055) 1px,transparent 1px),linear-gradient(90deg,rgba(154,126,255,.055) 1px,transparent 1px);background-size:54px 54px;mask-image:radial-gradient(ellipse at center,#000 0%,transparent 76%);animation:nxGridIn 1.3s ease .15s forwards}
.nx-premium-grid::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,transparent 0%,rgba(143,103,255,.13) 48%,transparent 52%);transform:translateY(-100%);animation:nxGridScan 3.6s cubic-bezier(.4,0,.2,1) .35s infinite}
.nx-premium-frame{inset:22px;border:1px solid rgba(184,164,255,.16);opacity:0;animation:nxFrameIn 1.1s cubic-bezier(.22,1,.36,1) .12s forwards}
.nx-premium-frame::before,.nx-premium-frame::after{content:"";position:absolute;left:50%;width:min(28vw,260px);height:1px;transform:translateX(-50%);background:linear-gradient(90deg,transparent,rgba(182,158,255,.62),rgba(255,255,255,.9),rgba(182,158,255,.62),transparent);filter:drop-shadow(0 0 5px rgba(142,104,255,.75))}
.nx-premium-frame::before{top:-1px}.nx-premium-frame::after{bottom:-1px;opacity:.7}
.nx-premium-corner{width:38px;height:38px;opacity:0;animation:nxCornerIn .8s cubic-bezier(.22,1,.36,1) .48s forwards}
.nx-premium-corner::before,.nx-premium-corner::after{content:"";position:absolute;background:rgba(202,188,255,.82);box-shadow:0 0 8px rgba(145,105,255,.42)}
.nx-premium-corner::before{width:100%;height:1px}.nx-premium-corner::after{width:1px;height:100%}
.nx-premium-corner.tl{top:22px;left:22px}.nx-premium-corner.tr{top:22px;right:22px;transform:scaleX(-1)}.nx-premium-corner.bl{bottom:22px;left:22px;transform:scaleY(-1)}.nx-premium-corner.br{bottom:22px;right:22px;transform:scale(-1)}
.nx-premium-label{font:9px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.24em;color:rgba(203,190,255,.6);opacity:0;animation:nxLabelIn .9s ease .85s forwards}
.nx-premium-label.top{top:39px;left:50%;transform:translateX(-50%)}.nx-premium-label.bottom{bottom:38px;left:50%;transform:translateX(-50%);letter-spacing:.32em;color:rgba(177,157,255,.48)}
.nx-premium-beam{top:50%;left:0;width:100%;height:1px;z-index:2;opacity:0;background:linear-gradient(90deg,transparent,rgba(151,115,255,.2) 18%,rgba(229,221,255,.7) 50%,rgba(151,115,255,.2) 82%,transparent);filter:drop-shadow(0 0 7px rgba(137,94,255,.55));animation:nxBeamPass 2.4s ease-in-out .65s forwards}
@keyframes nxGridIn{to{opacity:.7}}@keyframes nxGridScan{0%,100%{transform:translateY(-100%);opacity:0}18%{opacity:.65}62%{opacity:.28}85%{transform:translateY(100%);opacity:0}}
@keyframes nxFrameIn{from{opacity:0;inset:34px}to{opacity:1;inset:22px}}@keyframes nxCornerIn{from{opacity:0;transform:scale(.65)}to{opacity:.9}}
@keyframes nxLabelIn{to{opacity:.8}}@keyframes nxBeamPass{0%{opacity:0;transform:scaleX(.1)}35%{opacity:.9}100%{opacity:0;transform:scaleX(1)}}
#nexora-loader.done .nx-premium-grid,#nexora-loader.done .nx-premium-frame,#nexora-loader.done .nx-premium-corner,#nexora-loader.done .nx-premium-label,#nexora-loader.done .nx-premium-beam{opacity:0!important;transition:opacity .22s ease}
@media(max-width:600px){.nx-premium-frame{inset:12px}.nx-premium-corner.tl{top:12px;left:12px}.nx-premium-corner.tr{top:12px;right:12px}.nx-premium-corner.bl{bottom:12px;left:12px}.nx-premium-corner.br{bottom:12px;right:12px}.nx-premium-label{font-size:7px;letter-spacing:.16em}.nx-premium-label.top{top:25px}.nx-premium-label.bottom{bottom:25px}.nx-premium-corner{width:25px;height:25px}}
#nexora-loader.done{pointer-events:none}
#nexora-loader.done::before{transform:translateY(-100%)}
#nexora-loader.done::after{transform:translateY(100%)}
#nexora-loader.done .nx-logo{opacity:0!important;visibility:hidden!important;animation:none!important;transition:none!important}#nexora-loader.done .nx-aura,#nexora-loader.done .nx-orbit,#nexora-loader.done .nx-orbit2,#nexora-loader.done .nx-flash{opacity:0;transform:scale(.96);transition:opacity .3s ease,transform .8s cubic-bezier(.22,1,.36,1)}
@media(max-width:600px){.nx-logo{width:125px;height:125px}.nx-orbit{width:255px;height:94px}.nx-orbit2{width:210px;height:78px}.nx-aura{width:220px;height:220px}}

/* Nexora geometric line wordmark — cinematic line reveal */
.nx-line-logo{position:relative;top:42px;transform:translateY(0);width:min(58vw,480px);height:auto;aspect-ratio:910/370;margin:0 auto -24px;overflow:visible;filter:drop-shadow(0 0 7px rgba(145,115,255,.16));isolation:isolate;z-index:2}
.nx-line-logo::before{content:"";position:absolute;inset:8% 4%;pointer-events:none;background:radial-gradient(ellipse at 50% 45%,rgba(132,95,255,.12),transparent 62%);opacity:0;animation:nxLogoAura 1.4s ease-out .3s forwards,nxLogoAuraPulse 5s ease-in-out 2.4s infinite}
.nx-line-logo::after{content:"";position:absolute;left:9%;right:9%;top:54.5%;height:1px;background:linear-gradient(90deg,transparent,rgba(211,201,255,.52),rgba(255,255,255,.95),rgba(166,137,255,.6),transparent);transform:scaleX(0);transform-origin:center;opacity:0;pointer-events:none;animation:nxLogoScan 1.15s cubic-bezier(.22,1,.36,1) 1.8s forwards}
.nx-line-logo svg{display:block;width:100%;height:100%;overflow:visible}
.nx-line-logo .nx-word,.nx-line-logo .nx-baseline,.nx-line-logo .nx-vmark{fill:none;stroke:url(#nxLineGradient);stroke-width:1.45;stroke-linecap:butt;stroke-linejoin:round;vector-effect:non-scaling-stroke;stroke-dasharray:2200;stroke-dashoffset:2200;animation:nxStrokeDraw 1.9s cubic-bezier(.22,1,.36,1) forwards}
.nx-line-logo .nx-word{animation-delay:.18s;filter:drop-shadow(0 0 2px rgba(195,178,255,.14))}
.nx-line-logo .nx-baseline{stroke-width:1.25;animation-delay:.68s}
.nx-line-logo .nx-vmark{stroke-width:1.5;animation-delay:.42s;filter:drop-shadow(0 0 3px rgba(145,115,255,.24))}
@keyframes nxStrokeDraw{0%{stroke-dashoffset:2200;opacity:.2}65%{opacity:1}100%{stroke-dashoffset:0;opacity:1}}
@keyframes nxLogoAura{0%{opacity:0;transform:scale(.84)}65%{opacity:1}100%{opacity:.55;transform:scale(1)}}
@keyframes nxLogoAuraPulse{0%,100%{opacity:.28}50%{opacity:.72}}
@keyframes nxLogoScan{0%{transform:scaleX(0);opacity:0}35%{opacity:.95}100%{transform:scaleX(1);opacity:0}}
.nx-home-ready .nx-line-logo svg{animation:nxLogoBreathe 4.8s ease-in-out 2.2s infinite}
@keyframes nxLogoBreathe{0%,100%{filter:drop-shadow(0 0 2px rgba(173,153,255,.12))}50%{filter:drop-shadow(0 0 10px rgba(143,113,255,.4))}}
.nx-line-logo .nx-glint{fill:none;stroke:#fff;stroke-width:1.25;stroke-linecap:round;stroke-dasharray:85 1200;stroke-dashoffset:1285;opacity:0;filter:drop-shadow(0 0 3px rgba(255,255,255,.8));animation:nxGlintPass 4.2s cubic-bezier(.4,0,.2,1) 2.2s infinite}
@keyframes nxGlintPass{0%,10%{stroke-dashoffset:1285;opacity:0}18%{opacity:.85}48%{stroke-dashoffset:0;opacity:0}100%{stroke-dashoffset:0;opacity:0}}
@media(max-width:600px){.nx-line-logo{top:34px;width:min(76vw,360px);margin-bottom:-20px}}
@media(prefers-reduced-motion:reduce){.nx-line-logo *, .nx-line-logo::after,.nx-line-logo::before{animation-duration:.01ms!important;animation-iteration-count:1!important}}
.s{color:#a0a0c0;font-size:.95rem;margin-bottom:36px;opacity:0;transform:translateY(8px);transition:opacity .7s ease .08s,transform .7s cubic-bezier(.22,1,.36,1) .08s}.nx-home-ready .s{opacity:1;transform:none}
.sb{position:relative;display:flex;gap:10px;align-items:center;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.12);border-radius:50px;padding:6px 6px 6px 24px;overflow:hidden;opacity:0;transform:translateY(18px) scale(.96);transition:opacity .8s ease,transform .85s cubic-bezier(.22,1,.36,1),border-color .25s,box-shadow .35s}
.sb::before{content:"";position:absolute;inset:0;background:linear-gradient(105deg,transparent 20%,rgba(255,255,255,.11) 48%,transparent 76%);transform:translateX(-120%);pointer-events:none;z-index:1}
/* Search frame: the frame stays perfectly still; a long neon light runs along its rail */
.sb{border-color:rgba(166,139,255,.48);box-shadow:0 0 0 2px rgba(126,91,255,.12),inset 0 0 14px rgba(127,89,255,.07),0 0 22px rgba(118,82,255,.2)}
.sb-rail-light{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;z-index:2;border-radius:inherit}
.sb-rail-light path{fill:none;stroke:url(#nxRailGradient);stroke-width:2.5;stroke-linecap:round;stroke-dasharray:300 1900;stroke-dashoffset:0;filter:drop-shadow(0 0 3px rgba(255,255,255,.98)) drop-shadow(0 0 8px rgba(153,112,255,.98)) drop-shadow(0 0 17px rgba(120,72,255,.85));opacity:0}
.sb-track{position:absolute;inset:3px;border:1px solid rgba(159,128,255,.2);border-radius:inherit;pointer-events:none;z-index:0}
.nx-home-ready .sb{opacity:1;transform:none}.nx-home-ready .sb::before{animation:nxSearchSweep 1.4s cubic-bezier(.22,1,.36,1) .35s 1}.nx-home-ready .sb-rail-light path{opacity:1;animation:nxRailRun 2.4s linear infinite;transition:opacity .5s ease .25s}
@keyframes nxSearchSweep{to{transform:translateX(120%)}}
@keyframes nxRailRun{to{stroke-dashoffset:-2200}}
.sb:focus-within{border-color:rgba(126,105,255,.8);box-shadow:0 0 0 3px rgba(102,126,234,.12),0 0 32px rgba(102,80,255,.12)}
.sb input{position:relative;z-index:1;flex:1;background:none;border:none;outline:none;color:#fff;font-size:1.05rem;padding:12px 0}
.sb input::placeholder{color:#686880;transition:color .25s}.sb:focus-within input::placeholder{color:#8585a5}
.sb button{position:relative;z-index:1;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;border:none;border-radius:50px;padding:12px 28px;font-size:1rem;font-weight:600;cursor:pointer;white-space:nowrap;box-shadow:0 0 0 rgba(118,75,162,0);transition:transform .2s cubic-bezier(.22,1,.36,1),box-shadow .25s,filter .25s}
.sb button:hover{transform:translateY(-1px) scale(1.025);box-shadow:0 7px 22px rgba(102,82,220,.28);filter:brightness(1.08)}
.sb button:active{transform:scale(.96)}
.ql{display:flex;flex-wrap:wrap;gap:12px;justify-content:center;margin-top:28px}
a.q{display:inline-flex;align-items:center;gap:8px;padding:10px 22px;border-radius:50px;background:rgba(255,255,255,.065);border:1px solid rgba(255,255,255,.12);color:#fff;text-decoration:none;font-size:.95rem;font-weight:500;opacity:0;transform:translateY(12px) scale(.94);transition:background .25s,border-color .25s,transform .25s cubic-bezier(.22,1,.36,1),box-shadow .25s,opacity .6s ease}
.nx-home-ready a.q{opacity:1;transform:none}.nx-home-ready a.q:nth-child(1){transition-delay:.08s}.nx-home-ready a.q:nth-child(2){transition-delay:.14s}.nx-home-ready a.q:nth-child(3){transition-delay:.20s}
a.q:hover{background:rgba(102,126,234,.22);border-color:#667eea;transform:translateY(-2px);box-shadow:0 8px 22px rgba(75,65,180,.14)}
a.q:active{transform:scale(.96)}

/* ---- featured community panel: independent home UI, not a QuickLink ---- */
.nx-community-panel{position:relative;display:flex;align-items:center;gap:16px;margin:30px auto 0;padding:20px 20px 20px 18px;width:100%;text-align:left;overflow:hidden;border:1px solid rgba(173,145,255,.42);border-radius:20px;background:linear-gradient(112deg,rgba(91,67,178,.27),rgba(28,25,67,.76) 48%,rgba(34,29,79,.68));box-shadow:0 10px 34px rgba(8,5,30,.28),inset 0 1px 0 rgba(255,255,255,.08);opacity:0;transform:translateY(16px) scale(.985);transition:opacity .7s ease,transform .8s cubic-bezier(.22,1,.36,1),border-color .25s,box-shadow .25s}
.nx-home-ready .nx-community-panel{opacity:1;transform:none;transition-delay:.18s}
.nx-community-panel::before{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(105deg,transparent 12%,rgba(191,169,255,.12) 48%,transparent 82%);transform:translateX(-120%);animation:nxCommunitySweep 5.5s ease-in-out 1.2s infinite}
@keyframes nxCommunitySweep{0%,35%{transform:translateX(-120%)}72%,100%{transform:translateX(120%)}}
.nx-community-mark{position:relative;z-index:1;flex:none;width:58px;height:58px;display:grid;place-items:center;border-radius:17px;color:#eee8ff;background:linear-gradient(145deg,rgba(153,121,255,.34),rgba(91,67,178,.2));border:1px solid rgba(207,190,255,.3);box-shadow:0 0 24px rgba(139,103,255,.18)}
.nx-community-mark svg{width:29px;height:29px;fill:none;stroke:currentColor;stroke-width:1.65;stroke-linecap:round;stroke-linejoin:round}
.nx-community-copy{position:relative;z-index:1;flex:1;min-width:0}
.nx-community-kicker{display:flex;align-items:center;gap:7px;margin-bottom:5px;color:#c2b0ff;font-size:.68rem;font-weight:700;letter-spacing:.16em}
.nx-community-kicker i{width:6px;height:6px;border-radius:50%;background:#a78bfa;box-shadow:0 0 9px #a78bfa}
.nx-community-title{font-size:1.12rem;font-weight:700;letter-spacing:.025em;color:#fff}
.nx-community-desc{margin-top:4px;color:#b9b4d6;font-size:.78rem;line-height:1.5}
#nx-community{position:relative;z-index:1;flex:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:11px 15px;border:1px solid rgba(211,198,255,.35);border-radius:13px;background:linear-gradient(135deg,#8064e8,#6046b4);color:#fff;text-decoration:none;font-size:.82rem;font-weight:700;white-space:nowrap;box-shadow:0 5px 18px rgba(88,62,180,.28);transition:transform .2s,filter .2s,box-shadow .2s}
#nx-community svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
#nx-community:hover{transform:translateY(-2px);filter:brightness(1.12);box-shadow:0 8px 24px rgba(105,79,210,.4)}
#nx-community:active{transform:scale(.96)}
@media(max-width:480px){.nx-community-panel{gap:12px;padding:16px 14px}.nx-community-mark{width:48px;height:48px;border-radius:14px}.nx-community-mark svg{width:25px;height:25px}.nx-community-title{font-size:1rem}.nx-community-desc{font-size:.72rem}#nx-community{padding:10px 11px;font-size:.76rem;gap:5px}}
@media(max-width:370px){.nx-community-panel{flex-wrap:wrap}.nx-community-copy{min-width:calc(100% - 64px)}#nx-community{margin-left:60px}}
.h{margin-top:20px;font-size:.82rem;color:#585870}
#st{margin-top:10px;font-size:.78rem;color:#686880;min-height:1em}
.rec{margin-top:32px;text-align:left}
.rec h2{font-size:1rem;font-weight:600;color:#a0a0c0;margin-bottom:14px;text-align:center}
.rec ul{list-style:none;display:flex;flex-direction:column;gap:10px}
.rec li a{display:block;padding:12px 18px;border-radius:12px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:#c8c8e0;text-decoration:none;font-size:.9rem;transition:background .2s,border-color .2s,transform .1s;word-break:break-all}
.rec li a:hover{background:rgba(102,126,234,.2);border-color:#667eea}
.rec li a:active{transform:scale(.98)}
.rec{opacity:0;transform:translateY(14px);transition:opacity .7s ease,transform .8s cubic-bezier(.22,1,.36,1)}
.nx-home-ready .rec{opacity:1;transform:none}
#nx-session{opacity:0;transform:translateY(12px);transition:opacity .7s ease,transform .8s cubic-bezier(.22,1,.36,1)}
.nx-home-ready #nx-session{opacity:1;transform:none;transition-delay:.06s}
/* lightweight mode: no animated background, no opening, no logo / search-rail animation */
.nx-lite #nx-bg,.nx-lite #particles{display:none!important}
.nx-lite .nx-line-logo .nx-word,.nx-lite .nx-line-logo .nx-baseline,.nx-lite .nx-line-logo .nx-vmark{animation:none!important;stroke-dashoffset:0!important;opacity:1!important}
.nx-lite .nx-line-logo .nx-glint,.nx-lite .sb-rail-light,.nx-lite .sb::before,.nx-lite .nx-line-logo::before,.nx-lite .nx-line-logo::after{display:none!important}
.nx-lite .nx-line-logo,.nx-lite .nx-line-logo svg{animation:none!important;filter:none!important}
.rec:nth-of-type(1){transition-delay:.25s}.rec:nth-of-type(2){transition-delay:.32s}.rec:nth-of-type(3){transition-delay:.39s}.rec:nth-of-type(4){transition-delay:.46s}
#hbtn{transition:transform .22s cubic-bezier(.22,1,.36,1),border-color .25s,background .25s,box-shadow .25s}
#hbtn:hover{transform:translateY(-1px);border-color:rgba(126,105,255,.7)!important;background:rgba(102,126,234,.08)!important;box-shadow:0 6px 20px rgba(80,70,180,.12)}
.rec li a{transition:background .25s,border-color .25s,transform .22s cubic-bezier(.22,1,.36,1),box-shadow .25s!important}
.rec li a:hover{transform:translateX(4px);box-shadow:0 6px 18px rgba(70,60,170,.1)}
#particles{position:fixed;top:0;left:0;width:100%;height:100%;z-index:0;pointer-events:none}
.particle{position:absolute;top:0;border-radius:50%;background:rgba(168,179,255,.8);box-shadow:0 0 8px rgba(168,179,255,.6);animation:fallDown linear forwards}
@keyframes fallDown{0%{transform:translateY(-10vh) scale(0);opacity:0}10%{opacity:1}90%{opacity:.8}100%{transform:translateY(100vh) scale(1);opacity:0}}
/* ---- animated background (CSS only) ---- */
#nx-bg{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}
.nx-blob{position:absolute;border-radius:50%;will-change:transform}
.nx-blob.b1{width:62vmax;height:62vmax;left:-20vmax;top:-24vmax;background:radial-gradient(circle at 40% 40%,#6a5cff,transparent 66%);opacity:.5;animation:nxDrift1 26s ease-in-out infinite alternate}
.nx-blob.b2{width:54vmax;height:54vmax;right:-18vmax;top:8vh;background:radial-gradient(circle,#a855f7,transparent 66%);opacity:.36;animation:nxDrift2 32s ease-in-out infinite alternate}
.nx-blob.b3{width:48vmax;height:48vmax;left:8vw;bottom:-26vmax;background:radial-gradient(circle,#2bb3ff,transparent 66%);opacity:.26;animation:nxDrift3 29s ease-in-out infinite alternate}
.nx-blob.b4{width:34vmax;height:34vmax;right:12vw;bottom:-12vmax;background:radial-gradient(circle,#ff5fa2,transparent 66%);opacity:.14;animation:nxDrift4 37s ease-in-out infinite alternate}
@keyframes nxDrift1{0%{transform:translate3d(0,0,0) scale(1)}50%{transform:translate3d(14vw,10vh,0) scale(1.12)}100%{transform:translate3d(6vw,22vh,0) scale(.94)}}
@keyframes nxDrift2{0%{transform:translate3d(0,0,0) scale(1)}50%{transform:translate3d(-16vw,12vh,0) scale(.92)}100%{transform:translate3d(-6vw,-10vh,0) scale(1.1)}}
@keyframes nxDrift3{0%{transform:translate3d(0,0,0) scale(1)}50%{transform:translate3d(18vw,-12vh,0) scale(1.1)}100%{transform:translate3d(-8vw,-6vh,0) scale(.95)}}
@keyframes nxDrift4{0%{transform:translate3d(0,0,0) scale(1)}100%{transform:translate3d(-20vw,-18vh,0) scale(1.2)}}
#nx-hex{position:absolute;inset:0;width:100%;height:100%;-webkit-mask-image:radial-gradient(ellipse at 50% 45%,#000 25%,rgba(0,0,0,.4) 100%);mask-image:radial-gradient(ellipse at 50% 45%,#000 25%,rgba(0,0,0,.4) 100%)}
.nx-stars{position:absolute;top:0;left:0;width:2px;height:2px;border-radius:50%;background:transparent;box-shadow:43vw 21vh 0 0 rgba(200,190,255,.8),85vw 8vh 0 0 rgba(255,255,255,.85),70vw 14vh 0 0 rgba(200,190,255,.8),76vw 9vh 0 0 rgba(170,200,255,.75),29vw 6vh 0 0 rgba(255,255,255,.85),57vw 55vh 0 0 rgba(255,255,255,.85),32vw 13vh 0 0 rgba(170,200,255,.75),56vw 9vh 0 0 rgba(170,200,255,.75),17vw 30vh 0 0 rgba(170,200,255,.75),82vw 76vh 0 0 rgba(255,255,255,.85),75vw 76vh 0 0 rgba(200,190,255,.8),8vw 30vh 0 0 rgba(255,255,255,.85),73vw 19vh 0 0 rgba(200,190,255,.8),55vw 20vh 0 0 rgba(170,200,255,.75),17vw 75vh 0 0 rgba(200,190,255,.8),73vw 89vh 0 0 rgba(255,255,255,.85),15vw 76vh 0 0 rgba(170,200,255,.75),83vw 26vh 0 0 rgba(200,190,255,.8),14vw 72vh 0 0 rgba(170,200,255,.75),10vw 74vh 0 0 rgba(255,255,255,.85),81vw 28vh 0 0 rgba(200,190,255,.8),89vw 70vh 0 0 rgba(200,190,255,.8),42vw 61vh 0 0 rgba(170,200,255,.75),60vw 48vh 0 0 rgba(200,190,255,.8),33vw 25vh 0 0 rgba(170,200,255,.75),33vw 12vh 0 0 rgba(170,200,255,.75);animation:nxTwinkle 4.5s ease-in-out infinite alternate}
.nx-stars.s2{box-shadow:40vw 69vh 0 0 rgba(190,170,255,.7),45vw 95vh 0 0 rgba(190,170,255,.7),38vw 79vh 0 0 rgba(255,255,255,.7),17vw 67vh 0 0 rgba(190,170,255,.7),23vw 98vh 0 0 rgba(190,170,255,.7),21vw 64vh 0 0 rgba(190,170,255,.7),7vw 87vh 0 0 rgba(255,255,255,.7),73vw 75vh 0 0 rgba(190,170,255,.7),45vw 90vh 0 0 rgba(190,170,255,.7),78vw 65vh 0 0 rgba(190,170,255,.7),10vw 13vh 0 0 rgba(190,170,255,.7),62vw 91vh 0 0 rgba(255,255,255,.7),9vw 95vh 0 0 rgba(190,170,255,.7),84vw 75vh 0 0 rgba(190,170,255,.7),38vw 93vh 0 0 rgba(190,170,255,.7),87vw 46vh 0 0 rgba(255,255,255,.7),61vw 47vh 0 0 rgba(255,255,255,.7),80vw 16vh 0 0 rgba(190,170,255,.7),9vw 29vh 0 0 rgba(190,170,255,.7),18vw 96vh 0 0 rgba(255,255,255,.7);animation-duration:7s;animation-delay:2s}
@keyframes nxTwinkle{from{opacity:.2}to{opacity:1}}
.nx-beam{position:absolute;left:-30%;top:0;width:60%;height:100%;background:linear-gradient(105deg,transparent 35%,rgba(170,150,255,.05) 50%,transparent 65%);transform:translate3d(0,0,0);animation:nxBeamSlide 14s ease-in-out infinite alternate}
@keyframes nxBeamSlide{to{transform:translate3d(190%,0,0)}}
@media(prefers-reduced-motion:reduce){#nx-bg *{animation:none!important}}
/* ---- update log: top-right corner button ---- */
.nx-log{position:fixed;top:calc(12px + env(safe-area-inset-top,0px));right:12px;z-index:99990;opacity:0;transition:opacity .7s ease .3s}
.nx-home-ready .nx-log{opacity:1}
.nx-log summary{list-style:none;cursor:pointer;display:inline-flex;align-items:center;gap:8px;background:rgba(12,10,32,.55);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.16);color:#c9c5ee;border-radius:50px;padding:8px 15px;font-size:.78rem;letter-spacing:.03em;transition:border-color .25s,background .25s,box-shadow .25s,color .25s;-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none}
.nx-log summary::before{content:"";width:6px;height:6px;border-radius:50%;background:#a58aff;box-shadow:0 0 8px #a58aff}
.nx-log summary::-webkit-details-marker{display:none}
.nx-log summary:hover{border-color:rgba(126,105,255,.7);background:rgba(102,126,234,.14);box-shadow:0 6px 20px rgba(80,70,180,.18)}
.nx-log[open] summary{border-color:rgba(126,105,255,.75);color:#fff}
.nx-log-body{position:absolute;top:calc(100% + 10px);right:0;width:min(88vw,400px);max-height:min(70vh,560px);overflow:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding:2px 16px 14px;border-radius:14px;background:rgba(14,12,38,.94);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.12);box-shadow:0 18px 50px rgba(0,0,0,.45);text-align:left}
.nx-log-body h3{font-size:.74rem;font-weight:600;color:#a58aff;letter-spacing:.06em;margin:16px 0 8px}
.nx-log-body dl{display:grid;grid-template-columns:auto 1fr;gap:7px 14px;font-size:.8rem;line-height:1.55}
.nx-log-body dt{color:#fff;font-weight:600;white-space:nowrap}
.nx-log-body dd{margin:0;color:#b4b4cc}
</style>
</head>
<body>
<div id="nx-bg" aria-hidden="true"><i class="nx-blob b1"></i><i class="nx-blob b2"></i><i class="nx-blob b3"></i><i class="nx-blob b4"></i><canvas id="nx-hex"></canvas><div class="nx-beam"></div><i class="nx-stars"></i><i class="nx-stars s2"></i></div>
<div id="particles"></div>
<div id="nexora-loader">
  <div class="nx-aura"></div>
  <div class="nx-orbit"></div>
  <div class="nx-orbit2"></div>
  <div class="nx-flash"></div>
  <div class="nx-premium-grid" aria-hidden="true"></div>
  <div class="nx-premium-frame" aria-hidden="true"></div>
  <div class="nx-premium-corner tl" aria-hidden="true"></div>
  <div class="nx-premium-corner tr" aria-hidden="true"></div>
  <div class="nx-premium-corner bl" aria-hidden="true"></div>
  <div class="nx-premium-corner br" aria-hidden="true"></div>
  <div class="nx-premium-label top" aria-hidden="true">NEXORA&nbsp;&nbsp; / &nbsp;&nbsp; INTERFACE SYSTEM</div>
  <div class="nx-premium-label bottom" aria-hidden="true">INITIALIZING&nbsp; • &nbsp;SECURE SESSION</div>
  <div class="nx-premium-beam" aria-hidden="true"></div>
  <div class="nx-logo">
    <svg viewBox="0 0 200 200">
      <path class="nx-n" d="M72 145 L72 55 C72 48 78 45 83 51 L128 104 L128 145 M128 55 L128 145 C128 152 122 155 117 149 L72 96" />
      <ellipse class="nx-sweep" cx="100" cy="100" rx="78" ry="27" transform="rotate(-17 100 100)" />
      <path class="nx-star" d="M155 65 L158 72 L165 75 L158 78 L155 86 L152 78 L145 75 L152 72 Z" />
    </svg>
  </div>
</div>
<div id="nx-title-stage" aria-label="Nexora title screen">
  <div class="nx-title-glow" aria-hidden="true"></div>
  <div class="nx-title-content">
    <div class="nx-title-name">NEXORA</div>
    <div class="nx-title-byline">-made by wakame-</div>
  </div>
</div>

<script>
(function(){
  var loader=document.getElementById("nexora-loader");
  window.nexoraHideLoader=function(){
    if(!loader) return;
    loader.classList.add("done");
    setTimeout(function(){if(loader){loader.remove()}},850);
  };
})();
</script>
<div class="c">
${framed ? "" : DEBUG_UI_HTML}
<script>(function(){function nxStartIntro(){if(document.documentElement.classList.contains("nx-lite")){var l1=document.getElementById("nexora-loader"),t1=document.getElementById("nx-title-stage"),c1=document.querySelector(".c");if(l1)l1.remove();if(t1)t1.remove();if(c1)c1.classList.add("nx-home-ready");try{if(window.parent!==window)window.parent.postMessage({__nx:"home-ready"},location.origin)}catch(e){}return}${framed ? 'try{if(sessionStorage.getItem("__nx_intro")){var l0=document.getElementById("nexora-loader"),t0=document.getElementById("nx-title-stage"),c0=document.querySelector(".c");if(l0)l0.remove();if(t0)t0.remove();if(c0)c0.classList.add("nx-home-ready");try{window.parent.postMessage({__nx:"home-ready"},location.origin)}catch(e){}return}sessionStorage.setItem("__nx_intro","1")}catch(e){}' : ""}var loader=document.getElementById("nexora-loader"),title=document.getElementById("nx-title-stage"),c=document.querySelector(".c");if(c)c.classList.remove("nx-home-ready");if(title){title.classList.remove("show","leave");title.style.display="flex"}setTimeout(function(){if(window.nexoraHideLoader)window.nexoraHideLoader();if(title)title.classList.add("show")},2250);setTimeout(function(){if(title)title.classList.add("leave")},4050);setTimeout(function(){if(title&&title.parentNode)title.parentNode.removeChild(title);if(c)c.classList.add("nx-home-ready");try{if(window.parent!==window)window.parent.postMessage({__nx:"home-ready"},location.origin)}catch(e){}},4920)}if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",nxStartIntro,{once:true});else nxStartIntro()})();</script>
<div class="nx-line-logo" role="img" aria-label="Nexora geometric line logo">
<svg viewBox="60 55 910 370" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
 <defs><linearGradient id="nxLineGradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".52" stop-color="#e9e3ff"/><stop offset="1" stop-color="#a58aff"/></linearGradient></defs>
 <g class="nx-word">
  <!-- N --> <path d="M125 220 V78 L218 220 V78"/>
  <!-- E --> <path d="M265 78 V220 H355 M265 78 H355 M265 149 H342"/>
  <!-- X --> <path d="M397 78 L490 220 M490 78 L397 220"/>
  <!-- O --> <path d="M540 78 H620 V220 H540 Z"/>
  <!-- R --> <path d="M668 220 V78 H724 C773 78 773 140 724 140 H692 L774 220"/>
  <!-- A --> <path d="M812 220 L866 78 L920 220 M837 158 H895"/>
 </g>
 <path class="nx-baseline" d="M88 237 H946"/>
 <!-- Signature double-line V: clean, parallel strokes with no self-intersections -->
 <path class="nx-vmark" d="M190 300 L270 405 L381 237 M282 405 L393 237"/>
 <path class="nx-glint" d="M125 78 V220 L218 78 M265 78 H355 M397 78 L490 220 M540 78 H620 V220 M668 220 V78 H724 M812 220 L866 78 L920 220"/>
</svg>
</div>
<p class="s">v${NEXORA_VERSION}</p>
<form id="form"><div class="sb">
<svg class="sb-rail-light" viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="nxRailGradient" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#8054ff" stop-opacity="0"/><stop offset="14%" stop-color="#a58aff"/><stop offset="48%" stop-color="#ffffff"/><stop offset="66%" stop-color="#f5f0ff"/><stop offset="100%" stop-color="#8b5cff" stop-opacity="0"/></linearGradient></defs><path d="M 25 2 H 975 Q 998 2 998 25 V 75 Q 998 98 975 98 H 25 Q 2 98 2 75 V 25 Q 2 2 25 2 Z"/></svg>
<input id="target" type="text" placeholder="URL or search query" autocomplete="off" ${framed ? "" : "autofocus"}>
<button type="submit">Go</button>
</div></form>
<p id="st"></p>
<div id="nx-session" style="display:none;margin:12px 0 18px"><button id="nx-session-restore" type="button" style="background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.14);color:#ddd9ff;border-radius:12px;padding:10px 16px;font-size:.85rem;cursor:pointer">↩ 前回のセッションを復元</button><button id="nx-session-dismiss" type="button" style="display:none;background:none;border:0;color:#777791;margin-left:8px;font-size:.78rem;cursor:pointer">閉じる</button><div id="nx-session-label" style="margin-top:7px;font-size:.7rem;color:#777791;word-break:break-all"></div></div>
<section class="nx-community-panel" aria-label="Nexora Community">
  <div class="nx-community-mark" aria-hidden="true">
    <svg viewBox="0 0 24 24"><path d="M16 20v-1.4a3.6 3.6 0 0 0-3.6-3.6H6.6A3.6 3.6 0 0 0 3 18.6V20"/><circle cx="9.5" cy="7.5" r="3.5"/><path d="M17 11.5a3.4 3.4 0 0 0 0-6.6M17.5 15h.9a3.6 3.6 0 0 1 2.6 3.4V20"/></svg>
  </div>
  <div class="nx-community-copy">
    <div class="nx-community-kicker"><i></i> COMMUNITY</div>
    <div class="nx-community-title">コミュニティ</div>
    <div class="nx-community-desc">チャットと投稿(画像・音声・動画)</div>
  </div>
  <a href="#" id="nx-community">開く <svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg></a>
</section>
<div class="ql">
<a class="q" href="${link("https://taikoapp.uk")}">taikoweb</a>
<a class="q" href="${link("https://soraraw.net")}">まんがraw</a>
<a class="q" href="${link("https://yahoo.co.jp")}">Yahoo</a>
</div>
<div class="rec" id="hist" style="display:none">
<p style="text-align:center"><button id="hbtn" type="button" style="background:none;border:1px solid rgba(255,255,255,.2);color:#a0a0c0;border-radius:50px;padding:8px 18px;font-size:.85rem;cursor:pointer">最近開いたサイトを表示</button></p>
<ul id="histl" style="display:none;margin-top:14px"></ul>
</div>
<div class="rec">
<h2>Unblocked Links</h2>
<ul>
<li><a href="https://awakest.net/youtube-video-downloader/" target="_blank" rel="noopener">YouTube Downloader</a></li>
<li><a href="https://darkness-site.github.io/" target="_blank" rel="noopener">darkness site</a></li>
<li><a href="https://gigablast.org/" target="_blank" rel="noopener">GigaBlast</a></li>
<li><a href="https://w.atwiki.jp/plsk/pages/120.html" target="_blank" rel="noopener">リンク群</a></li>
<li><a href="https://canvasbackpackstore.com/" target="_blank" rel="noopener">fern</a></li>
<li><a href="https://xn4kq239b58hryh.netlify.app/wkt" target="_blank" rel="noopener">wakametube+</a></li>
</ul>
</div>
<details class="nx-log"><summary>アップデートログ</summary>
<div class="nx-log-body">
<h3>2026年11月</h3>
<dl>
<dt>v3.6.2</dt><dd>コミュニティのログインが毎回切れる問題を修正。ログイン情報を端末に保存するようにした。説明文を簡潔に変更</dd>
<dt>v3.6.1</dt><dd>ホームのコミュニティを独立したパネルに変更</dd>
<dt>v3.6.0</dt><dd>コミュニティをv3に更新。画像・音声・動画をR2ではなくDurable ObjectのSQLiteへ1MiB単位で保存。R2バケット設定を不要化。投稿上限・ファイル容量制限を調整。本人削除の識別子を固定し、合言葉は10文字以上・ログイン情報はタブのセッション内のみ保存</dd>
<dt>v3.5.0</dt><dd>コミュニティをv2に更新。名前登録・合言葉ログイン、重複名防止、管理者/本人による削除、画像・音声・動画のR2投稿に対応。投稿上限・容量制限・連投制限を追加</dd>
<dt>v3.4.0</dt><dd>共有コミュニティチャットを追加。ハブ Worker の Durable Object に最大200件の履歴を保存し、複数の Nexora サイトから同じチャットルームへ接続可能。ホームのコミュニティボタン、タブ表示、入力欄の統合に対応</dd>
<dt>v3.3.2</dt><dd>ページ表示中は上部タブ列を折りたたみ、タブ一覧・新規タブ操作を下部バーに統合。ホーム画面では上部タブ列を維持。ノッチ部分の余白を確保し、下部バーの最小化・復元とフローティングボタンにアニメーションを追加</dd>
<dt>v3.3.0</dt><dd>書き換えモードを追加(Relay 型。サイトごとに SW方式と切り替え可能。メニューの「互換モード」から。YouTube は既定で互換モード)。書き換えモードでは上流の応答(ステータス・content-length・206)をほぼそのまま返す</dd>
<dt>v3.2.2</dt><dd>ゲーム互換モードが実際には有効にならない不具合を修正(対象サイトでは iframe を書き換えず CSP も外す)。静的キャッシュが保存されていなかった問題を修正(JS は script 用 / それ以外で別キーに)。古いキャッシュを自動削除。シェル内で top.location / parent.location を読むサイトのエラーを修正。動画診断の伏せ字処理を修正</dd>
<dt>v3.2.1</dt><dd>iPad で、開いたページのどこを触ってもキーボードが出る問題に対策(操作なしの入力欄フォーカスを外す・遷移前にフォーカスを外す・ホームの自動フォーカスを廃止)。アイコン(favicon / ホーム画面アイコン)の背景を黒に変更</dd>
<dt>v3.2.0</dt><dd>軽量モードを追加(ホームの動く背景・オープニング・ロゴ演出を止め、ページ側の読み込み演出と監視処理を省略。ホームの下部ボタンまたはメニューから切り替え)。DOM を多用するページ向けに、ページ側の監視処理を軽量化</dd>
<dt>v3.1.0</dt><dd>Links を Unblocked Links に改名し、fern / wakametube+ を追加。オープニング後の表示順を統一(前回のセッション復元ボタン・タブ復元バナーも、ほかの項目と同じく順番に表示)</dd>
<dt>v3.0.3</dt><dd>タブバーと操作バーを刷新(タブにサイトのバッジ・読み込み表示、URLの見やすい表示、アイコン統一、メニュー・タブ一覧・戻る/進む長押しの履歴リスト、iPhone で入力時に画面が拡大されない)</dd>
<dt>v3.0.2</dt><dd>Yahoo 検索などで「戻る」を押すと URL に暗号化トークンが付いて 404 になる問題を修正。ゲーム中などに画面が固まって見える問題を修正(読み込みが終わらないページで読み込み演出が残り続けていた)。ゲームの音声・動画・wasm はキャッシュしないように変更。描画停止の検知を Debug Panel に追加</dd>
<dt>v3.0.1</dt><dd>ホームでは下のバーを隠し、ページを開いてから表示(オープニング中にバーが見えていた問題を修正)。暗号化URLが二重に包まれて読み込みエラーになる問題への対策(自動復元・履歴ずれの自己修復)</dd>
<dt>v3.0.0</dt><dd>常駐ブラウザシェルを導入(タブごとに iframe、ページ移動で Safari のトップレベルは遷移しない)。タブごとの内部履歴・URLバー・戻る/進む/再読み込み/ホーム、複数タブの状態維持、前回のタブの復元、Debug Panel のシェル統合</dd>
<dt>v2.5.20</dt><dd>ホーム画面にアップデートログ(右上のボタンで開閉)と動く背景(光のぼかし・星・六角形グリッドと波紋)を追加。タップした場所から広がる波紋を追加。スクロールすると背景の動きが最初に戻る問題を修正。キャッシュ名を更新</dd>
<dt>v2.5.19</dt><dd>ホーム画面を整理(セッション復元はドメインのみ表示、My sites と SIATUBES を削除)。ロゴの X の余分な線を修正。下部ナビバーに暗号化URLが出る不具合に対策。キャッシュ名を更新</dd>
<dt>v2.5.18</dt><dd>MutationObserver の監視対象をアイコン関連に限定。favicon 関連の正規表現を修正。Fetch Metadata(Sec-Fetch-*)を上流リクエストに復元。キャッシュ名を更新</dd>
<dt>v2.5.17</dt><dd>診断用正規表現を修正。If-Range 転送に対応。MutationObserver のマウントタイミングを改善</dd>
<dt>v2.5.16</dt><dd>動画エラーの診断機能を追加</dd>
<dt>v2.5.15</dt><dd>Request Monitor を導入。googlevideo.com/videoplayback の 403/530 を確認</dd>
<dt>v2.5.14</dt><dd>YouTube の再読み込み後にオフラインページが出る問題を調査・改善</dd>
<dt>v2.5.12</dt><dd>Cookie 周辺の構文エラーを修正</dd>
</dl>
<h3>2026年10月末</h3>
<dl>
<dt>v2.4.1</dt><dd>キャッシュ最適化、Debug Panel、Request Monitor、セッション復元など</dd>
<dt>v2.4.0</dt><dd>Game Compatibility Engine(ゲームの iframe をプロキシ対象外にする)</dd>
</dl>
<h3>2026年10月後半</h3>
<dl>
<dt>v2.3.2</dt><dd>更新ログの計画のみ確認(実装内容は不明)</dd>
<dt>v2.3.1</dt><dd>軽量化</dd>
<dt>v2.3.0</dt><dd>機能統合、互換性・安定性の強化</dd>
<dt>v2.2.x</dt><dd>遷移アニメーションの不具合を修正(nx-trans が head 内に入り込む問題)</dd>
<dt>v2.2</dt><dd>タブバーの移動機能、画面遷移アニメーション</dd>
<dt>v2.1</dt><dd>アニメーション、アイコン追加</dd>
</dl>
<h3>2026年10月</h3>
<dl>
<dt>v2.0.0</dt><dd>大規模リニューアル。内部構造を大幅に書き換え</dd>
<dt>v1.6.2</dt><dd>ユーザー報告でアップデート確認(変更内容は未記録)</dd>
<dt>v1.6.0</dt><dd>WebSocket、Cookie、iframe、画像・動画・HLS、EventSource、Worker に対応</dd>
<dt>v1.5.0</dt><dd>Client Hooks、fetch/XHR、SRI/CSP 対応</dd>
<dt>v1.4.0</dt><dd>戻る・進む、最近の履歴</dd>
<dt>v1.3.1</dt><dd>バージョン管理を導入</dd>
<dt>v1.0.x</dt><dd>初期基盤</dd>
</dl>
</div>
</details>
<p class="h">Enter a URL to browse, or search with Yahoo Japan</p>
<p class="h" style="margin-top:6px"><button id="nx-lite" type="button" style="background:none;border:1px solid rgba(255,255,255,.18);color:#9a9ab6;border-radius:50px;padding:6px 14px;font-size:.78rem;cursor:pointer"></button></p>
</div>
<div style="position:fixed;bottom:8px;right:8px;left:8px;font-size:.75rem;color:#585870;z-index:99999">made by wakame</div>
<script>
/* animated hex background (vanilla JS / canvas): hex grid + ripples (auto + tap) */
(function(){
var cv=document.getElementById('nx-hex');if(!cv||!cv.getContext)return;
if(document.documentElement.classList.contains('nx-lite'))return;
var ctx=cv.getContext('2d');
var reduce=!!(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches);
var dpr=Math.min(window.devicePixelRatio||1,1.5),w=0,h=0,side=20,dx=0,hs=0,hexs=[],ripples=[];
var running=false,last=0,nextRipple=0,rt=0,dirty=true;
function build(){
  w=window.innerWidth;
  /* canvas height is fixed to the tallest viewport we may see, so the toolbar showing/hiding while scrolling never changes it */
  h=Math.min(Math.max(window.innerHeight,(window.screen&&screen.height)||0),1600);
  cv.style.height=h+'px';
  side=w<600?18:22;dx=Math.sqrt(3)*side/2;hs=side/2;
  cv.width=Math.round(w*dpr);cv.height=Math.round(h*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  var dy=side*1.5;hexs=[];
  for(var x=-dx*2;x<w+dx*2;x+=dx*2){var i=0;for(var y=-dy;y<h+dy;y+=dy){i++;hexs.push({x:x+dx*(i%2),y:y})}}
  dirty=true;
}
function path(q){
  ctx.moveTo(q.x+dx,q.y-hs);ctx.lineTo(q.x,q.y-side);ctx.lineTo(q.x-dx,q.y-hs);
  ctx.lineTo(q.x-dx,q.y+hs);ctx.lineTo(q.x,q.y+side);ctx.lineTo(q.x+dx,q.y+hs);ctx.closePath();
}
function addRipple(x,y,v){
  if(ripples.length>=10)ripples.shift();
  ripples.push({x:x,y:y,r:0,max:Math.max(w,h)*0.6,v:v});
}
function draw(){
  var i,k,q;
  ctx.clearRect(0,0,w,h);
  for(i=ripples.length-1;i>=0;i--){ripples[i].r+=ripples[i].v;if(ripples[i].r>ripples[i].max)ripples.splice(i,1)}
  /* base grid: one batched stroke */
  ctx.lineWidth=1;ctx.strokeStyle='rgba(160,140,255,0.12)';ctx.beginPath();
  for(i=0;i<hexs.length;i++)path(hexs[i]);
  ctx.stroke();
  /* ripple light running along the grid lines */
  if(ripples.length){
    ctx.lineWidth=1.6;
    for(i=0;i<hexs.length;i++){
      q=hexs[i];var b=0;
      for(k=0;k<ripples.length;k++){
        var r=ripples[k],d=Math.abs(Math.sqrt((q.x-r.x)*(q.x-r.x)+(q.y-r.y)*(q.y-r.y))-r.r);
        if(d<48){var v=(1-d/48)*(1-r.r/r.max);if(v>b)b=v}
      }
      if(b>0.04){ctx.beginPath();path(q);ctx.strokeStyle='rgba(205,185,255,'+Math.min(1,b*0.85).toFixed(3)+')';ctx.stroke()}
    }
  }
}
function frame(now){
  if(!running)return;
  requestAnimationFrame(frame);
  if(now-last<33)return;
  last=now;
  if(now>nextRipple){addRipple(Math.random()*w,Math.random()*h,5);nextRipple=now+2600+Math.random()*2400}
  if(!ripples.length&&!dirty)return;
  draw();dirty=false;
}
function start(){if(running||reduce)return;running=true;requestAnimationFrame(frame)}
function stop(){running=false}
build();
if(reduce)draw();else start();
/* tap / click anywhere: a ripple spreads from that point (does not block the tap itself) */
document.addEventListener('pointerdown',function(e){
  if(!running||e.isPrimary===false)return;
  addRipple(e.clientX,e.clientY,6.5);
},{passive:true});
document.addEventListener('visibilitychange',function(){if(document.hidden)stop();else start()});
window.addEventListener('resize',function(){clearTimeout(rt);rt=setTimeout(function(){if(window.innerWidth===w&&window.innerHeight<=h)return;build();if(reduce)draw()},200)});
})();
</script>
<script>
var NX_KEY=${JSON.stringify(NX_KEY)};
${CODEC_SRC}
var SEARCH_BASE=${JSON.stringify(SEARCH_BASE)};
function isUrl(s){s=(s||'').trim();if(!s)return false;var l=s.toLowerCase();if(l.indexOf('http://')===0||l.indexOf('https://')===0)return true;if(/\\s/.test(s))return false;if(/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s))return true;if(/[.][a-zA-Z]{2,}/.test(s))return true;return false}
function save(u){try{var h=JSON.parse(localStorage.getItem('__nx_hist')||'[]');h=h.filter(function(x){return x!==u});h.unshift(u);localStorage.setItem('__nx_hist',JSON.stringify(h.slice(0,8)))}catch(e){}}
function go(v){var t=(v||'').trim();if(!t)return;var u;if(isUrl(t)){var l=t.toLowerCase();u=(l.indexOf('http://')===0||l.indexOf('https://')===0)?t:'https://'+t;save(u)}else{u=SEARCH_BASE+encodeURIComponent(t)}try{localStorage.setItem('__nx_last_session',u)}catch(e){}try{document.getElementById('target').blur()}catch(e){}location.href=nxWrapUrl('',u)}
(function(){try{var last=localStorage.getItem('__nx_last_session');if(!last)return;var box=document.getElementById('nx-session'),lab=document.getElementById('nx-session-label'),btn=document.getElementById('nx-session-restore');box.style.display='block';var dn=last;try{dn=new URL(last).hostname}catch(e){}lab.textContent=dn;btn.addEventListener('click',function(){location.href=nxWrapUrl('',last)});}catch(e){}})();
document.getElementById('form').addEventListener('submit',function(e){e.preventDefault();go(document.getElementById('target').value)});
/* 履歴は既定では表示しない（ボタンを押したときだけ、その場で作って見せる） */
(function(){try{var h=JSON.parse(localStorage.getItem('__nx_hist')||'[]');if(!h.length)return;document.getElementById('hist').style.display='';
document.getElementById('hbtn').addEventListener('click',function(){var ul=document.getElementById('histl');if(ul.style.display!=='none'){ul.style.display='none';ul.textContent='';this.textContent='最近開いたサイトを表示';return}
h.forEach(function(u){var li=document.createElement('li'),a=document.createElement('a');a.href=nxWrapUrl('',u);a.textContent=u;li.appendChild(a);ul.appendChild(li)});ul.style.display='';this.textContent='隠す'})}catch(e){}})();
(function(){var b=document.getElementById('nx-lite');if(!b)return;function lab(){b.textContent='軽量モード: '+(document.documentElement.classList.contains('nx-lite')?'オン':'オフ')}lab();b.addEventListener('click',function(){var on=!document.documentElement.classList.contains('nx-lite');try{localStorage.setItem('__nx_lite',on?'1':'0')}catch(e){}location.reload()})})();
document.getElementById('nx-community').addEventListener('click',function(e){e.preventDefault();var u=${JSON.stringify(COMMUNITY_HUB + P_COMMUNITY)};try{if(window.top!==window&&window.top.__nxShell&&window.top.__nxShell.openTab(u))return}catch(x){}location.href=u});
try{sessionStorage.removeItem('__nx_try')}catch(e){}
(function(){var st=document.getElementById('st');
if(!('serviceWorker' in navigator)){st.textContent='このブラウザは Service Worker に対応していません';return}
navigator.serviceWorker.register(${JSON.stringify(P_SW)},{scope:'/'}).then(function(){return navigator.serviceWorker.ready}).then(function(){st.textContent='準備完了'}).catch(function(e){st.textContent='準備できませんでした: '+e});
})();
</script>
</body>
</html>`;
}
