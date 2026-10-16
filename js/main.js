// Boot: wire everything together and run the animation loop.
(function (SF) {
  const S = SF.state;
  const cv = document.getElementById('cv');
  const mini = document.getElementById('mini');

  SF.initRender(cv);
  SF.initEditor(cv);
  SF.initUI();

  async function boot() {
    await SF.home.migrate();
    const m = location.hash.match(/plan=([A-Za-z0-9_-]+)/);
    let opened = false;
    if (m) {
      try {
        await SF.home.importDoc(await SF.decodeShare(m[1]), 'Shared factory'); opened = true;
        history.replaceState(null, '', location.href.split('#')[0]);        // opening it again would make another copy
        SF.toast('Opened the shared plan as a new factory');
      } catch (e) { SF.toast('Could not read the shared plan in the link', 'warn'); }
    }
    if (!opened) await SF.home.show();
    SF.renderInspector();
    SF.onLevel();
  }

  mini.addEventListener('mousedown', ev => {
    const go = e2 => {
      const r = mini.getBoundingClientRect();
      const map = mini._map; if (!map) return;
      const sx = (e2.clientX - r.left) * (mini.width / r.width), sy = (e2.clientY - r.top) * (mini.height / r.height);
      SF.view.cx = (sx - map.ox) / map.sc; SF.view.cy = (sy - map.oy) / map.sc;
    };
    go(ev);
    const mv = e2 => go(e2);
    const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
  });

  let frame = 0, lastTs = 0;
  function loop(ts) {
    const t = ts / 1000;
    if (SF.live) SF.live.tick(lastTs ? Math.max(0, t - lastTs) : 0);
    lastTs = t;
    if (SF.homeOpen) { /* the home screen covers the editor: nothing to draw */ }
    else if (SF.view3d && SF.view3d.active) SF.view3d.frame(t);
    else {
      SF.render(t);
      if (frame % 6 === 0) SF.renderMinimap(mini);
    }
    frame++;
    requestAnimationFrame(loop);
  }
  boot().then(() => requestAnimationFrame(loop));
})(window.SF);
