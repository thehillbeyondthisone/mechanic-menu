# Reality Repair

The third Workshop option opens `repair/`, a standalone bundled game. It works
from the public HTTPS Pages site without a LAN server or certificate setup.

Accept the job, drag open the service drawer, collect the probe and hold Space
or the inspection button. Extract the revealed regulator, seat it in the
socket, tune DEPTH/PHASE/GAIN until all three stay green, then run TEST.
Inspect the miniature afterward. Escape returns a held prop; R restarts.
The live terminal also performs the current action when clicked.

In WebXR, point and trigger to select, squeeze to grab/pull, hold trigger to
scan, and squeeze/twist a dial to calibrate. Release a regulator near its socket
to install it; elsewhere it returns safely. Use modest dial turns and regrip;
an existing large-turn limit remains a device-test follow-up.

This package retains the original authored roots, hitboxes, rules and live
640x400 screen. The probe, regulator, cabinet, moving drawer, three independent
dials and terminal housing use six first-pass65K TripoSplat masters. All assets
are separate rigid appearances; the full room/props total978670 Gaussians.
The original mesh-only miniature avoids duplicating the station splats.

Renderer: retain this app's own pinned Spark/Three vendor files. Nonuniform
station/housing fits require covariance on the meshes and paired
accumExtSplats/covSplats options on SparkRenderer. Runtime masks reserve drawer
travel, live-screen aperture and bounded photo-clutter footprints. The room
remains photo-derived scenery with limited novel-view support.

Original GLBs remain as fallback. `?terminal=original` selects the old terminal,
`?station=original` selects the old station/terminal, and `?props=original`
selects all original appearances. A generated-asset load failure retains the
corresponding authored visuals. Physical Quest performance/comfort is not
established by desktop or simulated XR checks.

Refresh/build with `python -B tools/make_site.py <output-directory>`. The
builder copies `viewer/repair/` without local servers, certificates, raw input
PNGs, private source paths or experiment logs. Vendor licenses and original
fallback/runtime assets are retained. Return through the header's Workshop link.
