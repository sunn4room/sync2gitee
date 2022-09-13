'use strict';

function info(msg) {
    console.log('\x1b[1;32m INFO\x1b[0m %s', msg);
}
function warn(msg) {
    console.log('\x1b[1;33m WARN\x1b[0m %s', msg);
}
function error(msg) {
    console.log('\x1b[1;31mERROR\x1b[0m %s', msg);
}
info('info');
warn('warn');
error('error');
async function main() {
    return new Promise(r => {
        setTimeout(() => r("done"), 2000);
    });
}
main();
