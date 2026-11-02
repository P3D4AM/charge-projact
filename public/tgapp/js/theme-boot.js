// Theme bootstrap — applied before first paint (v2.11.8: moved out of inline
// <script> so the CSP can forbid inline scripts entirely).
try {
  var t = localStorage.getItem('bc_theme') || 'auto';
  document.documentElement.dataset.theme = t;
} catch (e) { /* default theme */ }
