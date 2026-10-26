import './ui/style.css';
import { App } from './app';
import { mountUI } from './ui/ui';

async function boot(): Promise<void> {
  const root = document.getElementById('app')!;
  const app = new App();
  const ui = mountUI(root, app);
  try {
    await app.init(ui.canvas);
  } catch (err: any) {
    ui.fatal(String(err?.message ?? err));
    console.error(err);
    return;
  }
  ui.ready();
  (window as any).app = app;
  if (import.meta.env.DEV) {
    void import('./dev/bench').then((m) => m.installBench(app));
    void import('./dev/shots').then((m) => m.installShots(app));
    // courseSelfTest() in the console checks the course's own 2D engine and
    // every workshop challenge
    void import('./course/mini.selftest').then((m) => {
      (window as any).courseSelfTest = m.courseSelfTest;
      (window as any).miniSelfTest = m.miniSelfTest;
      (window as any).labSelfTest = m.labSelfTest;
    });
  }
  const loop = () => {
    app.update();
    ui.frame();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

void boot();
