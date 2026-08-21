# proposed rules

Empty on purpose.

Prometheus loads `*.yml` from this directory alongside `../alerts.yml`. It is
where a rule that alarmdrill *proposed* gets dropped to prove the loop closes:
drill → blind spot found → rule proposed → rule applied here → re-drill → the
same fault is now caught.

`alerts.yml` is the lab's deliberately incomplete rule set and must not be
edited to close a gap — `src/planted-gaps.test.ts` asserts it still matches
what `../../README.md` documents. This directory keeps the two separate: the
planted gaps stay planted, and the demo still has somewhere to put a fix.

Anything left here changes what the lab detects, so a file in this directory
means the baseline drill no longer measures the documented blind spots.
