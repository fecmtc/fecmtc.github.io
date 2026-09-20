// Headless checks for the simulation core in index.html. Run: node test.js
// The core has no DOM in it, so it is cut out of the page between its two markers and run as is.
const fs = require("fs"), assert = require("assert");
const html = fs.readFileSync(__dirname + "/index.html", "utf8");
const { Sim, Advisor } = (0, eval)(html.slice(html.indexOf("/* === SIM CORE START"), html.indexOf("/* === SIM CORE END === */")) + "; ({ Sim, Advisor })");
const rng = s => () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
const BASE = { mySpeed: 250, ping: 100, jitter: 0, loss: 0, svFps: 20, snaps: 20, smooth: true, smoothTime: 100, timeNudge: 0,
               enemySpeed: 250, turnEvery: 2, maxPackets: 30, packetDup: 1, noPredict: false };
const still = { x: 0, y: 0 }, right = { x: 1, y: 0 };

function run(set, { hz = 60, seconds = 30, input = () => still, width = 1000, seed = 5 } = {}) {
  const S = Sim.create({ ...BASE, ...set }, rng(seed)); S.setWorld(width, 300);
  const modes = {}; let n = 0, late = 0, acc = 0, back = 0, prevX = null;
  for (let i = 0; i < seconds * hz; i++) {
    acc += 1000 / hz; const ms = Math.floor(acc); acc -= ms; S.advance(ms, input(i / hz));
    if (S.cg.drawn) { if (prevX !== null && S.cg.drawn.x < prevX - 0.01) back++; prevX = S.cg.drawn.x; }
    if (S.now < 5000 || !S.cg.seen) continue;                       // give the client clock time to settle
    n++; modes[S.cg.mode] = (modes[S.cg.mode] || 0) + 1; late += S.now - S.cg.time;
  }
  const pct = k => 100 * (modes[k] || 0) / n;
  return { S, interp: pct("interp"), extrap: pct("extrap"), capped: pct("capped"), hold: pct("hold"), late: late / n, back, snapsPerSec: S.stats.downSent / seconds };
}
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: got ${a}, wanted ${b} ± ${tol}`);
let passed = 0; const test = (name, fn) => { fn(); passed++; console.log("ok  " + name); };

test("a clean line interpolates all the time, about half a ping plus one snapshot interval late", () => {
  // 97 Hz so frames do not phase-lock to the 50 ms interval; the client clock only moves on frames, so allow a frame of slack
  for (const ping of [20, 100, 300]) { const r = run({ ping }, { hz: 97 }); assert(r.interp > 99.5, `ping ${ping}: interp ${r.interp}%`); near(r.late, ping / 2 + 50, 11, `ping ${ping} lateness`); }
});
test("cl_timeNudge shifts what is shown; negative runs out of data, positive does not", () => {
  const zero = run({}, { hz: 97 }), neg = run({ timeNudge: -30 }, { hz: 97 }), pos = run({ timeNudge: 30 }, { hz: 97 });
  near(zero.late - neg.late, 30, 3, "-30"); near(pos.late - zero.late, 30, 3, "+30"); assert(neg.extrap > 30, "-30 should guess a lot"); assert(pos.interp > 99.5, "+30 should never guess");
});
test("jitter makes the client fall back further into the past, and guess now and then", () => {
  const r = run({ jitter: 60 }); assert(r.late > 120, `late ${r.late}`); assert(r.extrap > 1 && r.extrap < 30, `extrap ${r.extrap}%`);
});
test("cg_smoothClients only matters when the next snapshot is missing: guess (capped) versus hold", () => {
  const on = run({ loss: 20 }), off = run({ loss: 20, smooth: false }), short = run({ loss: 20, smoothTime: 20 });
  near(on.interp, off.interp, 0.01, "same interpolation share"); assert(on.extrap > 10 && on.hold === 0); assert(off.hold > 10 && off.extrap === 0); assert(short.capped > on.capped + 5, "a short cap freezes more");
});
test("snapshots leave only on server ticks: snaps is capped by sv_fps and quantised to it", () => {
  near(run({ snaps: 15 }).snapsPerSec, 10, 0.2, "sv_fps 20, snaps 15"); near(run({ snaps: 40 }).snapsPerSec, 20, 0.2, "sv_fps 20, snaps 40"); near(run({ svFps: 10, snaps: 20 }).snapsPerSec, 10, 0.2, "sv_fps 10");
});
test("out-of-order snapshots are dropped and the enemy never uses stale data", () => {
  const r = run({ jitter: 150 }); assert(r.S.stats.downStale > 50, "expected out-of-order arrivals");
  const h = r.S.cl.history; for (let i = 1; i < h.length; i++) assert(h[i].serverTime > h[i - 1].serverTime, "history must be in order");
});
test("your speed and the server's agree at any refresh rate and any packet settings, with no corrections", () => {
  for (const [hz, set] of [[60, {}], [120, {}], [144, { packetDup: 0 }], [60, { maxPackets: 125, packetDup: 5 }], [30, { ping: 400 }]]) {
    const r = run(set, { hz, seconds: 4, width: 4000, input: t => (t >= 1 && t < 3 ? right : still) }), S = r.S, tag = `${hz} Hz ${JSON.stringify(set)}`;
    near(S.cg.pred.x - 260, 500, 5, tag + " distance in 2 s"); near(S.sv.me.x, S.cg.pred.x, 0.001, tag + " server vs client");
    assert.strictEqual(S.stats.corrections, 0, tag + " corrections"); assert.strictEqual(S.stats.cmdsLost, 0, tag + " commands lost"); assert.strictEqual(r.back, 0, tag + " moved backwards");
  }
});
test("heavy jitter reorders packets: late ones are dropped, you never move backwards, and both sides end up agreeing", () => {
  // A packet overtaken by two later ones is dropped with its commands (cl_packetdup 1 only reaches back one packet), as in the game.
  const r = run({ jitter: 80 }, { seconds: 4, width: 4000, input: t => (t >= 1 && t < 3 ? right : still) }), S = r.S;
  assert(S.stats.upStale > 0, "expected out-of-order command packets"); assert.strictEqual(r.back, 0, "moved backwards");
  near(S.cg.pred.x - 260, 500, 10, "distance in 2 s"); near(S.sv.me.x, S.cg.pred.x, 0.001, "server vs client");
});
test("cl_packetdup rescues commands under loss", () => {
  const zig = t => (Math.floor(t / 0.15) % 2 ? right : { x: 0.6, y: 0.8 });
  const lost = [0, 1, 2, 5].map(d => run({ loss: 30, packetDup: d }, { seconds: 10, width: 4000, input: zig }).S.stats.cmdsLost);
  assert(lost[0] > 100 && lost[0] > lost[1] * 2 && lost[1] > lost[2] && lost[3] === 0, "lost per dup setting: " + lost);
});
test("a server-side shove causes exactly one correction of that size, one update later", () => {
  const S = Sim.create({ ...BASE }, rng(4)); S.setWorld(1200, 300);
  for (let i = 0; i < 200; i++) S.advance(16, still); S.shove(); const t0 = S.now;
  let when = null; for (let i = 0; i < 100; i++) { S.advance(16, still); if (when === null && S.stats.corrections) when = S.now - t0; }
  assert.strictEqual(S.stats.corrections, 1); near(S.stats.lastCorrection, 90, 0.5, "size"); assert(when >= 50 && when <= 130, `arrived after ${when} ms`); near(S.cg.pred.x, S.sv.me.x, 0.001, "settled");
});
test("moving the ping slider re-syncs quickly in both directions", () => {
  for (const [from, to] of [[20, 300], [300, 20]]) {
    const cfg = { ...BASE, ping: from }, S = Sim.create(cfg, rng(11)); S.setWorld(1000, 300);
    for (let i = 0; i < 300; i++) S.advance(16, still); cfg.ping = to; S.resync(); const t0 = S.now; let lastBad = t0;
    // the clock servo overshoots the newest snapshot by a few ms for a frame now and then, by design; that is not "unsettled"
    for (let i = 0; i < 180; i++) { S.advance(16, still); if (S.cg.mode !== "interp" && S.cg.extrapMs > 20) lastBad = S.now; }
    assert(lastBad - t0 < 400, `${from}->${to}: unsettled for ${lastBad - t0} ms`); near(S.now - S.cg.time, to / 2 + 50, 16,`${from}->${to} lateness`);
  }
});
test("a shot is judged where the enemy is when it arrives: a hit on a LAN, a miss at 300 ping", () => {
  for (const [ping, want] of [[4, true], [300, false]]) {
    const S = Sim.create({ ...BASE, ping, turnEvery: 1000 }, rng(2)); S.setWorld(4000, 300);
    for (let i = 0; i < 125; i++) S.advance(8, still);
    const shot = S.fire(S.cg.seen.x, S.cg.seen.y); for (let i = 0; i < 40; i++) S.advance(8, still);
    assert.strictEqual(shot.hit, want, `ping ${ping}: missed by ${shot.miss}`);
  }
});

// ---- the settings calculator ----
const mean = (conn, set, fps = 125) => { const seeds = [3, 7, 11, 19], acc = {}; for (const seed of seeds) { const r = Advisor.evaluate(conn, set, { fps, seed }); for (const k in r) acc[k] = (acc[k] || 0) + r[k] / seeds.length; } return acc; };
test("the calculator only ever suggests values the game accepts", () => {
  for (const ping of [0, 60, 400]) for (const jitter of [0, 25, 150]) for (const loss of [0, 2, 30]) for (const prefer of ["fresh", "balanced", "smooth"]) for (const fps of [60, 85, 125, 250]) for (const svFps of [20, 40]) {
    const r = Advisor.recommend({ ping, jitter, loss, prefer, fps, svFps }), tag = JSON.stringify({ ping, jitter, loss, prefer, fps, svFps });
    assert(r.maxPackets >= 30 && r.maxPackets <= 125 && Number.isInteger(r.maxPackets), tag); assert(r.packetDup >= 1 && r.packetDup <= 5, tag);
    assert(r.timeNudge >= -30 && r.timeNudge <= 30, tag); assert(r.rate >= 1000 && r.rate <= 90000, tag); assert.strictEqual(r.snaps, svFps, tag); assert.strictEqual(r.smooth, true, tag);
  }
});
test("ping decides one setting: prediction keeps 128 key presses, so a high ping caps com_maxfps", () => {
  const corrections = (ping, fps) => Advisor.evaluate({ ping, jitter: 0, loss: 0, svFps: 20 }, { ...Advisor.GAME_DEFAULTS, maxPackets: 125, packetDup: 5 }, { fps, seconds: 10 }).corrections;
  assert.strictEqual(corrections(300, 250), 0, "250 FPS is fine at ping 300"); assert(corrections(300, 500) > 50, "500 FPS is not: a clean line, yet constant corrections");
  for (const [ping, fps] of [[60, 1000], [150, 1000], [300, 500], [400, 333], [400, 1000]]) {
    const r = Advisor.recommend({ ping, jitter: 0, loss: 0, fps, svFps: 20 }), tag = `ping ${ping}, ${fps} FPS -> ${r.maxFps}`;
    assert(r.maxFps <= fps && r.maxFps >= 60, tag); assert.strictEqual(corrections(ping, r.maxFps), 0, tag + " should predict cleanly");
  }
  assert.strictEqual(Advisor.recommend({ ping: 60, jitter: 3, loss: 0, fps: 250, svFps: 20 }).maxFps, 250, "an ordinary ping leaves your FPS alone");
});
test("the pitfall the calculator exists for: cl_maxpackets 125 with cl_packetdup 1 loses key presses on a jittery line", () => {
  const conn = { ping: 60, ...Advisor.STYLES.wifi, svFps: 20 }, D = Advisor.GAME_DEFAULTS;
  assert(mean(conn, D).keyPressesLost < 0.1, "the defaults are safe"); assert(mean(conn, { ...D, maxPackets: 125 }).keyPressesLost > 2, "125 with one repeat is not");
});
test("the calculator's settings never do worse than the game defaults where it promises better", () => {
  for (const [style, ping] of [["wired", 40], ["wifi", 60], ["mobile", 90], ["unstable", 200]]) for (const fps of [60, 125]) {
    const conn = { ping, ...Advisor.STYLES[style], svFps: 20 }, base = mean(conn, Advisor.GAME_DEFAULTS, fps);
    for (const prefer of ["fresh", "balanced", "smooth"]) {
      const r = mean(conn, Advisor.recommend({ ...conn, prefer, fps }), fps), tag = `${style} ${fps} fps ${prefer}`;
      assert(r.keyPressesLost <= Math.max(0.1, base.keyPressesLost), `${tag}: key presses lost ${r.keyPressesLost}% vs ${base.keyPressesLost}%`);
      assert(r.inputAge <= base.inputAge + 1, `${tag}: input age ${r.inputAge} vs ${base.inputAge}`);
      if (prefer !== "smooth") assert(r.off <= base.off + 0.7, `${tag}: enemy off by ${r.off} vs ${base.off}`);
      if (prefer === "smooth") assert(r.jumps <= base.jumps + 0.05, `${tag}: jumps ${r.jumps} vs ${base.jumps}`);
    }
  }
});
console.log(`\n${passed} tests passed`);
