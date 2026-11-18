'use strict';

const { applyEditThrottle } = require('../../src/utils/editThrottle');
const bot = applyEditThrottle({
    options: { apiUrl: 'https://shared.example.org/w/api.php' },
    async request() {
        process.send({ event: 'started' });
        await new Promise(resolve => process.once('message', resolve));
        process.send({ event: 'finished' });
    },
}, { priority: process.env.TEST_PRIORITY || 'normal' });

process.send({ event: 'ready' });
bot.request({ action: 'edit' }).then(() => {
    process.send({ event: 'released' }, () => process.disconnect());
}, error => {
    process.send({ event: 'error', message: error.stack }, () => process.disconnect());
    process.exitCode = 1;
});
