import { useEffect, useRef, useState } from 'react';

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FullscreenRoot = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type LockableOrientation = ScreenOrientation & {
  lock?: (orientation: 'landscape') => Promise<void>;
  unlock?: () => void;
};
const fullscreenElement = () => document.fullscreenElement ?? (document as FullscreenDocument).webkitFullscreenElement;

/** Browser only: native desktop window controls are managed separately. */
export function WebFullscreen({ onNotice }: { onNotice?: (message: string) => void }) {
  const [active, setActive] = useState(() => !!fullscreenElement());
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const busy = useRef(false);
  const locked = useRef(false);
  const mounted = useRef(true);
  const notify = (message: string) => {
    if (!mounted.current) return;
    setNotice(message);
    onNotice?.(message);
  };
  const unlock = () => {
    if (!locked.current) return;
    locked.current = false;
    try { (screen.orientation as LockableOrientation | undefined)?.unlock?.(); } catch { /* Already unlocked by the browser. */ }
  };

  useEffect(() => {
    mounted.current = true;
    const changed = () => {
      const fullscreen = !!fullscreenElement();
      setActive(fullscreen);
      if (!fullscreen) unlock();
    };
    document.addEventListener('fullscreenchange', changed);
    document.addEventListener('webkitfullscreenchange', changed);
    return () => {
      mounted.current = false;
      document.removeEventListener('fullscreenchange', changed);
      document.removeEventListener('webkitfullscreenchange', changed);
      unlock();
    };
  }, []);

  async function toggle() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    notify('');
    const exiting = !!fullscreenElement();
    try {
      if (exiting) {
        const doc = document as FullscreenDocument;
        const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen;
        if (!exit) { notify('请使用浏览器的返回或退出全屏操作。'); return; }
        await exit.call(doc);
        unlock();
      } else {
        const root = document.documentElement as FullscreenRoot;
        const request = root.requestFullscreen ?? root.webkitRequestFullscreen;
        if (!request) {
          notify('当前浏览器不支持网页全屏，请手动横屏；也可通过浏览器菜单添加到主屏幕。');
          return;
        }
        // Invoke before any await so the request retains the tap's user activation.
        await request.call(root);
        if (!mounted.current || !fullscreenElement()) return;
        const orientation = screen.orientation as LockableOrientation | undefined;
        if (orientation?.lock) {
          try {
            await orientation.lock('landscape');
            if (!mounted.current || !fullscreenElement()) {
              try { orientation.unlock?.(); } catch { /* The browser may already have released it. */ }
              return;
            }
            locked.current = true;
          } catch {
            notify('已进入全屏；如未自动横屏，请关闭手机的方向锁定并手动横过来。');
          }
        } else {
          notify('已进入全屏，请将手机横过来玩。');
        }
      }
    } catch {
      notify(exiting ? '未能退出全屏，请使用浏览器的退出全屏操作。' : '浏览器未允许全屏，请重试，或手动横屏继续玩。');
    } finally {
      busy.current = false;
      if (mounted.current) {
        setActive(!!fullscreenElement());
        setPending(false);
      }
    }
  }

  return <>
    <button type="button" className="text-button web-fullscreen-button" aria-label={active ? '退出全屏' : '全屏横屏玩'} aria-pressed={active} disabled={pending} onClick={() => void toggle()}>{pending ? '切换中…' : active ? '退出全屏' : '全屏'}</button>
    {!onNotice && notice && <span className="web-fullscreen-notice" role="status">{notice}</span>}
  </>;
}
