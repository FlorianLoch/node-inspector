var gen = (function * (a, b) { yield a; return b; })(1, '2');
gen.next();

function log() {
  console.log({a:1});
  setTimeout(log, 1000);
}
setTimeout(log, 1000);
