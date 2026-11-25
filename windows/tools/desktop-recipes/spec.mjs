// Changes to the official Grok Bot 1.3.0 app.asar (Windows x64, macOS arm64, macOS x64,
// Linux x64 and Linux arm64), built into recipes by build.mjs. Each anchor must occur
// exactly once in its source; a different official build is refused instead of being half patched.
// Code that the recipes append lives in extensions/ (it is the source, not dead code).
//
// Edits: { prepend | append | replaceAll: text }, { insertBefore | insertAfter: anchor, text },
// { replace: anchor, text }, { cutFrom: anchor, text } (drops the rest of the file),
// { removeThrough: [startAnchor, endAnchor], text }.
import { readFileSync } from 'node:fs';

const extension = name => readFileSync(new URL(`./extensions/${name}`, import.meta.url), 'utf8');
const asset = name => `dist/renderer/assets/${name}`;
const edit = (name, edits) => ({ path: asset(name), source: asset(name), edits });
const I18N = "import { grokText } from './grok-local-i18n.js';\n";

export const PLATFORM_CHUNKS = {
  windows: {
    sentry: 'chunk-sentry-sdk-DbVOwbnU.js',
    eagerCommon: 'index.eager-common-rGW_2t4Y.js',
    eagerApp: 'index.eager-app-B8R_eIgV.js',
    connectedApps: 'chunk-view-Ck6m2dRl.js',
    sharepointWrite: 'chunk-plugin-detail-sharepoint-write-Cx4udrmK.js',
    library: 'chunk-bot-store-files-library-Buv97Hok.js',
    generalPane: 'chunk-general-pane-CZkpGQLQ.js',
    computerView: 'chunk-view-_JwVsmv_.js',
    updateView: 'chunk-view-BwAtZhGc.js',
    marketplaceBrowse: 'chunk-marketplace-browse-model-CWOU11f0.js',
    pluginDetail: 'chunk-plugin-detail-view-BuFNWAJl.js',
  },
  'mac-arm64': {
    sentry: 'chunk-sentry-sdk-CX49MNl7.js',
    eagerCommon: 'index.eager-common-rGW_2t4Y.js',
    eagerApp: 'index.eager-app-BrdVnhlw.js',
    connectedApps: 'chunk-view-BZhHf36f.js',
    sharepointWrite: 'chunk-plugin-detail-sharepoint-write-Bjrtqiq1.js',
    library: 'chunk-bot-store-files-library-D69l2OSw.js',
    generalPane: 'chunk-general-pane-BYlQ0xzS.js',
    computerView: 'chunk-view-XovHfDRc.js',
    updateView: 'chunk-view-vZqeG1gy.js',
    marketplaceBrowse: 'chunk-marketplace-browse-model-C2vE2WYs.js',
    pluginDetail: 'chunk-plugin-detail-view-CV7-Z9ff.js',
  },
  'mac-x64': {
    sentry: 'chunk-sentry-sdk-Cw7rY2oR.js',
    eagerCommon: 'index.eager-common-rGW_2t4Y.js',
    eagerApp: 'index.eager-app-6m_k8xdV.js',
    connectedApps: 'chunk-view-xNHC-_w2.js',
    sharepointWrite: 'chunk-plugin-detail-sharepoint-write-Dg88w24S.js',
    library: 'chunk-bot-store-files-library-C2UXXtjc.js',
    generalPane: 'chunk-general-pane-Ce12dsFk.js',
    computerView: 'chunk-view-BC5Twrke.js',
    updateView: 'chunk-view-CR79mJex.js',
    marketplaceBrowse: 'chunk-marketplace-browse-model-DjXZiX7C.js',
    pluginDetail: 'chunk-plugin-detail-view-BvMbet6K.js',
  },
  'linux-x64': {
    sentry: 'chunk-sentry-sdk-Chwq3-ME.js',
    eagerCommon: 'index.eager-common-rGW_2t4Y.js',
    eagerApp: 'index.eager-app-CIV_rOgf.js',
    connectedApps: 'chunk-view-CVx0r4LU.js',
    sharepointWrite: 'chunk-plugin-detail-sharepoint-write-JevkHorF.js',
    library: 'chunk-bot-store-files-library-ZUkhSB2s.js',
    generalPane: 'chunk-general-pane-DDHm5cE5.js',
    computerView: 'chunk-view-BlOLYXAt.js',
    updateView: 'chunk-view-C6r3bPYv.js',
    marketplaceBrowse: 'chunk-marketplace-browse-model-CErNOYtN.js',
    pluginDetail: 'chunk-plugin-detail-view-Q38AWWxL.js',
  },
  'linux-arm64': {
    sentry: 'chunk-sentry-sdk-BDHhjGY8.js',
    eagerCommon: 'index.eager-common-rGW_2t4Y.js',
    eagerApp: 'index.eager-app-DqvMmste.js',
    connectedApps: 'chunk-view-BELWKkQz.js',
    sharepointWrite: 'chunk-plugin-detail-sharepoint-write-ZvamD5NV.js',
    library: 'chunk-bot-store-files-library-DGqR0Q_x.js',
    generalPane: 'chunk-general-pane-BArjKVys.js',
    computerView: 'chunk-view-juNoUmx2.js',
    updateView: 'chunk-view-lRMTtlEF.js',
    marketplaceBrowse: 'chunk-marketplace-browse-model-F9CQJAcQ.js',
    pluginDetail: 'chunk-plugin-detail-view-DgAUY13Q.js',
  },
};

export function buildSpec(target = 'windows') {
  const chunks = PLATFORM_CHUNKS[target];
  if (!chunks) throw new Error(`Unknown desktop recipe target: ${target}`);

  return [
    // The local client (mac/clients/desktop) reuses a few original main-process modules. Each
    // copy stops before the original entry point runs and exports what the client needs.
    {
      path: 'dist/electron-main/local-browser.cjs', source: 'dist/electron-main/main-app.cjs',
      edits: [
        { prepend: 'require("./local-shared.cjs");\n' },
        { cutFrom: 'var Wxt=y(Dy()),jxt=y(uxt()),be=(0,$xt.readMainCoreHandoff)();',
          text: '\nmodule.exports={requestPasskey:WKe,requestPin:VKe,updatePasskey:Mnn,finishPasskey:Lee};\n' },
      ],
    },
    {
      path: 'dist/electron-main/local-shared.cjs', source: 'dist/electron-main/main-core.cjs',
      edits: [
        { cutFrom: 'p8({killSwitch:process.env.CURSOR_DISABLE_HALF_OPEN_ASYNC_ITERATOR_FIX});var BZ=eke(),CYe=S8({scope:"sand-desktop"});',
          text: '\nmodule.exports={activateLocale:BA};\n' },
      ],
    },
    {
      path: 'dist/local-exec-daemon/main.cjs', source: 'dist/local-exec-daemon/main.cjs',
      edits: [
        { removeThrough: ['pZt().catch(r=>{let e=r instanceof Error?r:new Error(String(r));process.stderr.write(`[sand-local-exec-daemon] fatal:',
          'finally(()=>process.exit(1))});'],
          text: 'module.exports={Provider:Xx,ComputerUse:Zx,findComputerHelper:Fc,decideLocalUse:jK,isLocalUseBlocked:gEe,retireApproval:mEe,parseApproval:Uft};' },
      ],
    },
    {
      path: 'dist/node-agent-coordinator/local-browser.cjs', source: 'dist/node-agent-coordinator/main.cjs',
      edits: [
        { cutFrom: 'mbe().catch(n=>{process.stderr.write(`node-agent-coordinator: composition failure:',
          text: '\nmodule.exports={passkeyProvider:cW,signer:g5,findSigner:f5,relyingParty:pW,interval:Ds,reconnect:pbe,deadline:at,watchdog:oo,delivery:Kt,expiry:Vi};\n' },
      ],
    },

    { path: asset('grok-local-i18n.js'), source: null, edits: [{ append: extension('grok-local-i18n.js') }] },

    // No crash reports leave the local client.
    edit(chunks.sentry, [
      { replaceAll: 'const noop=()=>{};export function initSandSentrySdk(){return{captureException:noop,captureMessage:noop,setTag:noop,withScope:noop}}' },
    ]),
    edit(chunks.eagerCommon, [
      { insertBefore: 'if(Rt(e[0])){if(Nt.size===0)It({kind:`exception`,args:e})', text: 'return;' },
      { insertBefore: 'if(Nt.size===0)It({kind:`message`,args:e})', text: 'return;' },
    ]),

    // Connected apps: only apps the Host can serve, a local empty state and the Host's share link.
    edit(chunks.connectedApps, [
      { replace: 'c=r?n.filter(sl):n;', text: 'c=n.filter(sl);' },
      { replace: 'onSelect:()=>y(xn(D)),children:N', text: 'onSelect:()=>y(r.shareUrl),children:N' },
    ]),
    edit(chunks.sharepointWrite, [
      { prepend: I18N },
      { replace: ':e(f)}function ht(e){', text: ':grokText(`暂无连接应用`,`No connected apps`)}function ht(e){' },
    ]),

    // Bot library: the Host accepts 20 MiB per file, 100 files and 100 MiB per Bot. Host Bots
    // keep one shared library and no per-user store; files can be picked as well as dropped.
    edit(chunks.library, [
      { prepend: I18N + `import { eO as GrokButton } from './${chunks.eagerApp}';\n` },
      { replace: 'oe=26214400,k=1073741824', text: 'oe=20971520,k=104857600' },
      { replace: 'e.sizeBytes>26214400?{kind:`too-large`}:t.fileCount>=200?{kind:`too-many-files`}:t.totalBytes+e.sizeBytes>1073741824?',
        text: 'e.sizeBytes>20971520?{kind:`too-large`}:t.fileCount>=100?{kind:`too-many-files`}:t.totalBytes+e.sizeBytes>104857600?' },
      { replace: 'let he;return t[57]!==J||t[58]!==$?(he=(0,V.jsxs)(V.Fragment,{children:[J,$]}),t[57]=J,t[58]=$,t[59]=he):he=t[59],he}',
        text: 'return(0,V.jsxs)(V.Fragment,{children:[k?(0,V.jsx)(GrokLibraryUpload,{upload:N,disabled:P}):null,$]})}' },
      { append: extension('library.js') },
    ]),

    // Settings > General: the account card shows this Host and opens the connection dialog;
    // realtime voice is a local setting; no security key proxy.
    edit(chunks.generalPane, [
      { prepend: I18N },
      { replace: '(H=(0,$.jsx)(`span`,{className:V,children:z}),',
        text: '(H=typeof z==`string`?(0,$.jsx)(GrokAccountName,{className:V,name:z,onCommit:name=>n.updateName(name)}):(0,$.jsx)(`span`,{className:V,children:z}),' },
      { replace: '(oe=(0,$.jsx)(`span`,{className:U,children:A}),',
        text: '(oe=(0,$.jsx)(`span`,{className:U,children:(0,$.jsx)(GrokAccountHost,{})}),' },
      { replace: '(G=D?(0,$.jsx)(K,{disabled:P,onClick:c?()=>void n.cancelLoginFlight():()=>void s(),size:`md`,style:vr.actionWeakBorder,variant:`secondary`,children:c?(0,$.jsx)(Y,{id:`dEgA5A`}):(0,$.jsx)(Y,{id:`MPPZ54`})}):null,',
        text: '(G=(0,$.jsx)(GrokHostConnection,{}),' },
      // Notification sounds are a development-only section upstream; show it without DEV markers.
      { replace: '(n=t?(0,$.jsx)($i,{}):null,', text: '(n=(0,$.jsx)($i,{}),' },
      { replace: '(f=(0,$.jsx)(Mt,{children:d}),', text: '(f=d,' },
      { replace: 'label:x(n({id:`EJ5f2m`}))', text: 'label:n({id:`EJ5f2m`})' },
      { replace: '"aria-label":x(n({id:`FK/hQQ`}))', text: '"aria-label":n({id:`FK/hQQ`})' },
      // Auto-review: a short description, and no team-rule hints.
      { replace: '(g=a(l==null?{id:`De8ppO`}:{id:`QqKsGg`}),',
        text: '(g=l==null?grokText(`运行操作前检查，需要时询问。`,`Review actions and ask when needed.`):a({id:`QqKsGg`}),' },
      { replace: '(0,$.jsx)(Kn,{children:(0,$.jsx)(Y,{id:`NFRGrQ`})})', text: 'null' },
      { replace: '(0,$.jsx)(b,{as:`span`,color:`tertiary`,level:`sm`,children:h})]}):null', text: 'null]}):null' },
      { replace: 'children:[l,f,p,m,x,S,h,g,_,v,y,b,C,w,T,E,D]',
        text: 'children:[l,f,(0,$.jsx)(GrokRealtimeVoiceSettings,{}),p,m,x,S,h,g,_,v,y,b,C,T,E,D]' },
      { append: extension('general-pane.js') },
    ]),

    // Settings > Computer: the Host manages the Bot's computer; this computer's access stays.
    edit(chunks.computerView, [
      { prepend: I18N },
      { replace: '(0,Q.jsxs)(`div`,{...n,children:[i,a,o,s]})',
        text: '(0,Q.jsxs)(`div`,{...n,children:[(0,Q.jsx)(GrokRemoteDesktop,{}),i,a,o]})' },
      { append: extension('computer-view.js') },
    ]),

    // Settings > Updates: the local build has no updater.
    edit(chunks.updateView, [
      { prepend: I18N },
      { replace: '(t=(0,x.jsx)(_,{children:(0,x.jsx)(T,{})}),',
        text: '(t=(0,x.jsx)(_,{children:(0,x.jsx)(GrokLocalVersion,{})}),' },
      { append: extension('update-view.js') },
    ]),

    // Marketplace: Host apps form their own category; hide public links for both Host and LOGIN_AND_CREDENTIAL_MANAGEMENT entries.
    edit(chunks.marketplaceBrowse, [
      { replace: 'var u=[`credentials`,', text: 'var u=[`host`,`credentials`,' },
      { replace: 'd={LOGIN_AND_CREDENTIAL_MANAGEMENT:`credentials`,', text: 'd={HOST:`host`,LOGIN_AND_CREDENTIAL_MANAGEMENT:`credentials`,' },
      { replace: 'var T={credentials:{id:`D1dENt`},', text: 'var T={host:{id:`Host`,message:`Host`},credentials:{id:`D1dENt`},' },
    ]),
    edit(chunks.pluginDetail, [
      { replace: 'function Vt(e,t){if(e.marketplace?.ownership===`user`)return null;',
        text: 'function Vt(e,t){if(e.category===`Host`||e.category===`LOGIN_AND_CREDENTIAL_MANAGEMENT`)return null;if(e.marketplace?.ownership===`user`)return null;' },
    ]),

    edit(chunks.eagerApp, [
      { prepend: I18N + `const GROK_LIBRARY_CHUNK = './${chunks.library}';\n` },
      { replace: 'VU={FEATURED:{id:`FkMol5`},', text: 'VU={HOST:{id:`Host`,message:`Host`},FEATURED:{id:`FkMol5`},' },
      // Account menu: connection settings instead of adding a cloud account; no mobile app offer.
      { replace: '(et=(0,Z.jsxs)(Rw.Section,{children:[Ye,Xe,$e]}),', text: '(et=(0,Z.jsxs)(Rw.Section,{children:[Xe,$e]}),' },
      { replace: 'onSelect:ze,children:(0,Z.jsx)($o,{id:`MPPZ54`})}):null,',
        text: 'onSelect:()=>{window.__grokLocalConnectionRequested=true;c(`general`);window.dispatchEvent(new Event(`grokbot-local:connect-request`))},children:grokText(`连接设置`,`Connection settings`)}):null,' },
      // Signing out disconnects from the Host; nothing stays on a cloud computer.
      { replace: 'description:toe(e)===null?xi._({id:`5qRD8O`}):xi._({id:`W51kAS`}),', text: 'description:``,' },
      // Bot settings: title, instructions and library files are kept on the Host; the Host
      // chooses the voice, so neither the Bot nor a call offers voice settings.
      { replace: '(c=(0,Z.jsxs)(`div`,{...r,children:[i,o,s]}),',
        text: '(c=(0,Z.jsxs)(`div`,{...r,children:[i,o,s,(0,Z.jsx)(GrokLocalSettings,{agent:n})]}),' },
      { insertAfter: 'function _Nt(e){', text: 'return null;' },
      { replace: 'let M=j;!M&&(g===`settings`||v===`settings`)', text: 'let M=!1;!M&&(g===`settings`||v===`settings`)' },
      // Connected apps: hide built-in official 1Password native entry; no link to the cloud Bot templates.
      { replace: 'n=Tee({onepassword:!0,email:t})', text: 'n=Tee({onepassword:!1,email:t})' },
      { insertAfter: 'function Lrn(){', text: 'return null;' },
      // No crash reporter, heap samples or idle sampling.
      { insertAfter: 'function Het(e,t,n=Vet){', text: 'return{load:async()=>{},setTag:()=>{}};' },
      { insertAfter: 'function Efi(e,t,n={}){', text: 'return()=>{};' },
      { insertAfter: 'function Nfi(e,t=document){', text: 'return{sampleIdleMinutes:()=>void 0,stop:()=>{}};' },
      // Realtime calls go to the Host relay (host/server/voice-session.mjs), which transcribes,
      // runs the Bot, speaks and records the call. The client sends no presence, nudges,
      // written turns, greeting or tool results, keeps no call journal and never resumes.
      { replace: 'ce=(t,n)=>e.source.setVoiceCallPresence({id:t.agentId,callId:t.callId,isOnTheLine:n,acceptsOverheard:t.acceptsOverheard})',
        text: 'ce=(t,n)=>Promise.resolve()' },
      { insertAfter: 'Te=async(t,n,r,i)=>{if(!hY.canHangUp(t.phase))return;', text: 'n===`hung-up`&&t.session?.localVoiceEndCall?.();' },
      { replace: 'P=e=>e.didConnect?(e.journalLine??=', text: 'P=e=>!1?(e.journalLine??=' },
      { insertBefore: 'let n=A();if(n===null||n.phase===`ending`||n.agentId!==t.agentId||n.callId!==t.callId', text: 'return;' },
      { insertBefore: 'let i=A();if(i===null||!hY.isCallerOnTheLine(i.phase)||i.agentId!==t||n!==i.thread.sessionId)return;Oe(i,r);', text: 'return;' },
      // Turning realtime voice off in Settings ends the current call.
      { insertAfter: 'je=e.transcript.observeEntriesFeed({onAppended:ke,onBaseline:Ae,onFetched:({agentId:e,sessionId:t,read:n})=>Ae({agentId:e,sessionId:t,entries:n})})',
        text: ',grokVoicePreferenceRelease=window.localBot.onVoicePreferenceChanged(enabled=>{enabled||void q()})' },
      { replace: 'dispose(){je();', text: 'dispose(){grokVoicePreferenceRelease(),je();' },
      // The local client mints a short-lived ticket for this Host; only that address is dialable.
      { replace: 'let r=await e.desktop.mintVoiceCallCredential();',
        text: 'let r=await window.localBot.mintVoiceCredential(this.dial.agentId);grokVoiceEndpoint=r.ok?r.credential.websocketUrl:null;' },
      { replace: 'function Edi(e){return Tdi(e.desktop,wdi(e))}',
        text: 'function Edi(e){return{session:async()=>({instructions:``,tools:[],hasOverheard:!1,greeting:{direction:``,withLandedWork:``}}),callTool:async()=>{throw Error(`Voice tools are managed by the Host`)}}}' },
      { replace: 'var ihi=class e{static DIALABLE_ORIGIN=`wss://api.x.ai/`;static isDialableURL(t){return t.startsWith(e.DIALABLE_ORIGIN)}',
        text: 'let grokVoiceEndpoint=null;var ihi=class e{static isDialableURL(t){return typeof t==`string`&&t===grokVoiceEndpoint}' },
      // Speech plays through a media element, and the Host hears when each reply finished
      // playing (response.playback.done) and when the caller hangs up (session.close).
      { replace: 'let s=r.createMediaStreamDestination(),c=new e(r,a,o,s,t);return c.hold(n,i),c}',
        text: 'let s=r.createMediaStreamDestination(),speaker=new Audio;speaker.autoplay=!0,speaker.srcObject=s.stream,await speaker.play();let c=new e(r,a,o,s,t);return c.localOutput=speaker,c.hold(n,i),c}' },
      { replace: 'n.connect(this.context.destination),n.connect(this.speakerTap);', text: 'n.connect(this.speakerTap);' },
      { replace: 'teardown(){this.dropScheduledSpeech(),',
        text: 'teardown(){this.localOutput?.pause(),this.localOutput&&(this.localOutput.srcObject=null),this.dropScheduledSpeech(),' },
      { replace: 'responseHeard=[];socket;router;responses;',
        text: 'responseHeard=[];localVoiceHeard=new Set;localVoiceGeneration=0;socket;router;responses;' },
      { replace: 'onCallerInterrupted:()=>{this.cancelUserFirstOpen(),',
        text: 'onCallerInterrupted:()=>{this.localVoiceGeneration++,this.localVoiceHeard.clear(),this.cancelUserFirstOpen(),' },
      { replace: 'onAssistantResponseEnded:e=>{this.sendTruncations(',
        text: 'onAssistantResponseEnded:e=>{e||void this.localVoicePlaybackDone(),this.sendTruncations(' },
      { replace: 't.speak(e,this.responses.speaksForNudgeId),this.args.handlers.onAudioReceived?.()',
        text: 't.speak(e,this.responses.speaksForNudgeId),e.itemId!==null&&this.localVoiceHeard.add(e.itemId),this.args.handlers.onAudioReceived?.()' },
      { insertAfter: 'thisResponseHasBeenHeard(){for(let e of this.responseHeard.splice(0))e()}',
        text: 'async localVoicePlaybackDone(){let items=[...this.localVoiceHeard],generation=this.localVoiceGeneration,audio=this.audio;if(audio===null||items.length===0)return;try{await audio.whenScheduledSpeechEnds()}catch{return}if(this.phase.kind!==`live`||generation!==this.localVoiceGeneration||this.router.callerIsSpeaking||this.socketSilentlyDiscardsFrames())return;for(let item_id of items)this.socket.send(JSON.stringify({type:`response.playback.done`,item_id}));this.localVoiceHeard.clear()}localVoiceEndCall(){this.socketSilentlyDiscardsFrames()||this.socket.send(JSON.stringify({type:`session.close`}))}' },
      { replace: 't.kind===`event`&&this.router.route(t.event)',
        text: 't.kind===`event`&&((t.event.type===`response.created`||t.event.type===`response.cancelled`)&&(this.localVoiceGeneration++,this.localVoiceHeard.clear()),this.router.route(t.event))' },
      { replace: 'openAfterUserFirstGrace(){let e=this.pendingConnectGreeting;e!==null&&(this.pendingConnectGreeting=null,this.responses.greet(e))}',
        text: 'openAfterUserFirstGrace(){this.cancelUserFirstOpen()}' },
      { replace: 'resumption:{enabled:!0}', text: 'resumption:{enabled:!1}' },
      { append: extension('eager-app.js') },
    ]),

    // The render-trace hook installs a React DevTools stub for the vendor's render sampling,
    // which this client does not run.
    { path: 'dist/renderer/index.html', source: 'dist/renderer/index.html', edits: [
      { replace: '    <script src="./assets/dune-render-trace-hook-265eb7be.js"></script>\n', text: '' },
    ] },
  ];
}

export const SPEC = buildSpec('windows');
