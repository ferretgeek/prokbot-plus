// Android changes to the original renderer, applied after the desktop recipes.
// Each target file is verified by SHA-256 first, and every anchor must occur exactly
// once, so a different official build is refused instead of being half patched.
import { createHash } from 'node:crypto';

export const RENDERER_PATCHES = [
  {
    file: 'assets/index.eager-app-CrGjYQbA.js',
    sha256: 'f17c145c7816c898432e143bf8f8185c93d8b3fe1d881948c6e3af73931123cd',
    edits: [
      // The conversation details pane (Bot computer, files, skills) opens only when the
      // window can hold sidebar + chat + pane side by side, and otherwise asks the desktop
      // to widen the window. A phone cannot widen; there the pane opens as a full-screen
      // layer instead (android.css).
      ['function HUe(e){return e.windowWidth>=IR(e.sidebar,bi)}', 'function HUe(e){return!0}'],
      ['function qUe(e){return Math.max(0,IR(e.sidebar,bi)-e.windowWidth)}', 'function qUe(e){return 0}'],
      ['function jUe(e){const t=e.expandedWidth+il+(e.openInfoPaneWidth??0);return Math.max(0,t-e.windowWidth)}', 'function jUe(e){return 0}'],
    ],
  },
  {
    file: 'assets/index-CUXtfEUp.js',
    sha256: '6e08e299755840bc1488a032180a9117578d5ddeda8b0c99ab6fde6a062f759c',
    edits: [
      // "Teach a task" records the desktop screen, which a phone cannot provide; the
      // composer gets no teach action, as on platforms without recording.
      ['(tl=j==null?{}:{onTeachClick:j},', '(tl={},'],
      // "Get Grok Bot for mobile" advertises the official phone apps of the cloud service.
      ['(Ee=r.jsx(vt.Item,{leading:je,onSelect:se,children:Se}),', '(Ee=null,'],
      // Like the official phone app, a Bot row shows when the Bot was last active (the time
      // slot is otherwise unused in the list); client/layout.js formats the time.
      ['let tn;n[121]!==Ue?(tn=Ue?r.jsx(GD,{}):null,n[121]=Ue,n[122]=tn):tn=n[122];',
        'let tn;n[121]!==Ue?(tn=Ue?r.jsx(GD,{}):null,n[121]=Ue,n[122]=tn):tn=n[122];' +
        'tn=tn??globalThis.grokbotActivityTime?.(s.lastActivityAt)??null;'],
    ],
  },
  {
    file: 'assets/chunk-computer-screen-preview-BnTMKGxa.js',
    sha256: '9ab8a5dd6cd20fc732d466ca20ae861dd3d17d5471db99fa7a821e39ba2d75af',
    edits: [
      // The Bot computer view is laid over its placeholder with CSS anchor positioning,
      // which WebView builds before Chromium 125 drop. The same values are also kept as
      // custom properties, which client/anchor-fallback.js resolves on those builds.
      ['const Ce={positionAnchor:se,top:"anchor(top)",right:"anchor(right)",bottom:"anchor(bottom)",left:"anchor(left)"},' +
        'Gs={positionAnchor:Qs,top:"anchor(top)",left:"anchor(left)",width:"anchor-size(width)",height:"anchor-size(height)"},',
      'const Ce={positionAnchor:se,top:"anchor(top)",right:"anchor(right)",bottom:"anchor(bottom)",left:"anchor(left)",' +
        '"--grokbot-anchor-top":"anchor(top)","--grokbot-anchor-right":"anchor(right)","--grokbot-anchor-bottom":"anchor(bottom)","--grokbot-anchor-left":"anchor(left)"},' +
        'Gs={positionAnchor:Qs,top:"anchor(top)",left:"anchor(left)",width:"anchor-size(width)",height:"anchor-size(height)",' +
        '"--grokbot-anchor-top":"anchor(top)","--grokbot-anchor-left":"anchor(left)","--grokbot-anchor-width":"anchor-size(width)","--grokbot-anchor-height":"anchor-size(height)"},'],
    ],
  },
];

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** Returns the patched bytes of `name`, or null when the file has no Android patch. */
export function patchRendererFile(name, bytes) {
  const patch = RENDERER_PATCHES.find(item => item.file === name);
  if (!patch) return null;
  if (sha(bytes) !== patch.sha256) throw new Error(`界面文件与支持的版本不一致：${name}`);
  let text = Buffer.from(bytes).toString('utf8');
  for (const [from, to] of patch.edits) {
    const at = text.indexOf(from);
    if (at < 0 || text.indexOf(from, at + 1) >= 0) throw new Error(`界面补丁锚点不唯一：${name}`);
    text = text.slice(0, at) + to + text.slice(at + from.length);
  }
  return Buffer.from(text, 'utf8');
}
