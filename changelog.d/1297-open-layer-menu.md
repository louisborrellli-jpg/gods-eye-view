- The Data Layers panel starts open for a first-time visitor, the mirror of the
  rule that starts Display collapsed. It is the menu — the quick views and
  every feed live in it — and behind a collapsed `+` a newcomer saw a globe and
  no way into it. A stored choice still wins in both directions, so collapsing
  it sticks.
- Layer group headings render as headings again. Making them collapsible turned
  them from `<h3>` into `<button>`, which inherited the user-agent button skin
  and painted an opaque light box across the panel. They now carry an explicit
  reset, plus a `+`/`–` marker driven by `aria-expanded` so a folded group says
  so.
