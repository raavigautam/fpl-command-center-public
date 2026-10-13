// Loads Code.js into a VM with Apps Script services stubbed, so the pure
// algorithmic functions can be exercised outside Apps Script.
const fs = require('fs');
const vm = require('vm');

const props = {};
const cache = {};
const sandbox = {
  console,
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = String(v); },
      deleteProperty: k => { delete props[k]; },
      getProperties: () => Object.assign({}, props)
    })
  },
  CacheService: {
    getScriptCache: () => ({
      get: k => (k in cache ? cache[k] : null),
      put: (k, v) => { cache[k] = v; },
      remove: k => { delete cache[k]; },
      removeAll: ks => ks.forEach(k => delete cache[k])
    })
  },
  UrlFetchApp: {
    fetch: () => { throw new Error('network disabled in harness'); },
    fetchAll: () => { throw new Error('network disabled in harness'); }
  },
  Utilities: {
    getUuid: () => 'test-uuid',
    sleep: () => {},
    gzip: b => b, ungzip: b => b,
    base64Encode: s => Buffer.from(String(s)).toString('base64'),
    base64Decode: s => Buffer.from(String(s), 'base64'),
    newBlob: s => ({ getDataAsString: () => String(s), setContentType: () => {} }),
    formatDate: d => String(d)
  },
  Logger: { log: () => {} },
  MailApp: { sendEmail: () => {} },
  SpreadsheetApp: { openById: () => { throw new Error('no sheet'); } },
  HtmlService: { createTemplateFromFile: () => ({ evaluate: () => ({}) }) },
  ScriptApp: { getProjectTriggers: () => [], newTrigger: () => { throw new Error('no triggers'); } },
  Session: { getScriptTimeZone: () => 'UTC' }
};
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(process.env.CODE_PATH || require('path').join(__dirname, '..', 'Code.js'), 'utf8'), sandbox, { filename: 'Code.js' });
module.exports = sandbox;
