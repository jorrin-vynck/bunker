(function () {
  // Colours for the browser bar; the two themes the app offers.
  var T = { graphite: '#121212', paper: '#dcd8cc' };
  var ALLOWED = ['graphite', 'paper'];
  var t = 'graphite';
  try { var v = JSON.parse(localStorage.getItem('theme')); if (v && ALLOWED.indexOf(v) >= 0) t = v; } catch (e) { /* storage blocked */ }
  document.documentElement.setAttribute('data-theme', t);
  var m = document.querySelector('meta[name=theme-color]');
  if (m) m.setAttribute('content', T[t]);
  window.__themes = T;
})();
