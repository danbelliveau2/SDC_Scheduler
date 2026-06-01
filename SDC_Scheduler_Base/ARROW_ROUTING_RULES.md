# Arrow Routing Rules

Source of truth. When something looks wrong, find the rule and fix the implementation.

## Layering (z-order)

1. **Arrows are the bottom layer.** Bars, milestone diamonds, and labels paint on top.
   When an arrow has to pass through a bar or a milestone label, it goes BEHIND, not
   over. So we don't try to route around bars — we just route the simplest path and
   let the layer order hide whatever overlaps.

## Path shape (max two segments, one corner)

2. **Straight line** when pred and succ line up: a single vertical or horizontal.
3. **L-shape** otherwise: one corner — either horizontal-then-vertical or
   vertical-then-horizontal, whichever puts the final segment in the direction the
   arrowhead points.
4. **No U-routes, no corridors, no loops, no step-up hooks.**

## Pred-side exit

5. **Bar pred, succ above/below at an x within pred's range** → exit STRAIGHT DOWN/UP
   from pred's bottom/top edge at that x. Single-segment path.
6. **Bar pred, succ above/below outside pred's x range** → exit horizontally from the
   side closest to succ at center y, then drop. L-shape.
7. **Bar pred, succ in same row** → exit from pred's left or right side at center y.
8. **Milestone pred** → exit from the diamond's top vertex (going up), bottom vertex
   (going down), or the side vertex closest to succ (same row).
9. **Multiple outgoing arrows on the same side edge** → stagger their exit y so they
   don't share a horizontal. Straight-drop exits don't need staggering (each gets its
   own x derived from its succ).

## Succ-side entry

10. **Bar succ from above/below** → enter the TOP or BOTTOM edge at an x near the
     side that matches the dependency type (FS/SS near the left edge, FF/SF near the
     right edge). Final segment is vertical, arrowhead points DOWN or UP.
11. **Bar succ from the side** → enter at the LEFT or RIGHT edge at center y. Final
     segment is horizontal, arrowhead points RIGHT or LEFT.
12. **Milestone succ** → enter the closest vertex along the dependency direction.

## Labels

13. **Bar labels stay INSIDE the bar.** If the task name doesn't fit at the current
     zoom, truncate with an ellipsis. Hover shows the full name. Never spill outside,
     never use a separate pill.
14. **Milestone labels are plain text to the right of the diamond, every time.** No
     pill, no alternate-side heuristic. If an arrow crosses one, it passes underneath
     via the layer order (rule 1).

## Adjustments

15. **Live re-render** on zoom change, predecessor edit, or row drag — geometry
     changes drive a fresh routing pass.
