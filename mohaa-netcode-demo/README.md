# mohaa-netcode-demo

Why did that shot miss? A hands-on picture of how Medal of Honor: Allied Assault shows you other players (slightly in the past) and yourself (optimistically), in two simulations:

1. **Other players**: snapshot interpolation, extrapolation when an update is late, and the delay that comes with both.
2. **You**: client-side prediction, server reconciliation, and what `cl_maxpackets` / `cl_packetdup` do to your key presses.
3. **Settings calculator**: give it your ping, connection type, FPS and what you prefer; it suggests `rate`, `snaps`, `com_maxfps`, `cl_maxpackets`, `cl_packetdup`, `cl_timeNudge`, `cg_smoothClients` and `cg_smoothClientsTime`, each with its reason. Its rules were calibrated against the simulation, and `test.js` holds them to it. Two findings: on a jittery line, `cl_maxpackets 125` with `cl_packetdup 1` loses key presses that the defaults do not (packets overtake each other and late ones are dropped); and prediction keeps only 128 key presses, one per frame, so a high ping caps the FPS it can keep up with.

Online at: https://fecmtc.github.io/mohaa-netcode-demo/

## How faithful is it?

The simulation core follows the [OpenMoHAA](https://github.com/openmoh/openmohaa) source (checked at commit `667c50f9`): the client clock (`CL_SetCGameTime`, `CL_AdjustTimeDelta`), entity interpolation and the `cg_smoothClients` extrapolation cap (`CG_CalcEntityLerpPositions`, `BG_EvaluateTrajectory`), snapshot pacing (`SV_SendClientMessages`, `snaps` capped by `sv_fps`), command packets and duplicate rejection (`CL_WritePacket`, `SV_UserMove`), prediction with `cg_errordecay` (`CG_PredictPlayerState`), and out-of-order packets being dropped (`Netchan_Process`). Defaults and clamps are the game's.

What is simplified on purpose (flat field, no physics, no delta compression, even jitter and loss) is listed at the bottom of the page.

## Development

Everything is in `index.html`, no build step. The simulation core has no DOM in it and sits between two markers in the page, so it can be tested headlessly:

```bash
node mohaa-netcode-demo/test.js
```

This demo used to live in its own repository, `fecmtc/mohaa-netcode-demo`; it is now part of [fecmtc.github.io](https://github.com/fecmtc/fecmtc.github.io), at the same address.
