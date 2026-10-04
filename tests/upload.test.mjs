// Test: the admin upload page's file-picker section — the 50 MB ceiling,
// the size-check meter, and the sign-in/help screens staying free of default
// credentials. Loads the real index.html in jsdom like e2e.test.mjs does.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function boot(seedSettings) {
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://petgabs.github.io/MAdv/',
    pretendToBeVisual: true,
    beforeParse(window) {
      try {
        Object.defineProperty(window, 'crypto', {
          value: {
            randomUUID: () => require('node:crypto').randomUUID(),
            getRandomValues: (a) => require('node:crypto').randomFillSync(a)
          }, configurable: true
        });
      } catch (e) {}
      window.scrollTo = () => {};
      window.URL.createObjectURL = () => '#test-blob';
      window.URL.revokeObjectURL = () => {};
      window.fetch = () => Promise.resolve(new window.Response('{}', { status: 200 }));
      window.HTMLElement.prototype.scrollIntoView = () => {};
      if (seedSettings) window.localStorage.setItem('madv.settings.v2', JSON.stringify(seedSettings));
    }
  });
  return dom;
}

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};

const MB = 1024 * 1024;

// --- 1. Fresh device: default limit is 50 MB everywhere -------------------
console.log('1. fresh defaults');
{
  const dom = boot(null);
  const w = dom.window, d = w.document;
  check('state.settings.maxSizeMB is 50', w.state.settings.maxSizeMB === 50);
  check('uploadLimitMB() is 50', w.uploadLimitMB() === 50);
  w.showView('upload');
  w.updateUploadMode();
  check('step head badge reads "Maximum 50 MB"', d.querySelector('#max-size-label').textContent === 'Maximum 50 MB');
  check('facts grid limit reads "50 MB"', d.querySelector('#dz-max-fact').textContent === '50 MB');
  const input = d.querySelector('#opt-max-size');
  check('settings input capped at 50', input.max === '50' && input.value === '50');
  check('dropzone exists with file input', !!d.querySelector('#dropzone') && !!d.querySelector('#upload-file'));
  const dropzone = d.querySelector('#dropzone');
  check('dropzone uses a structured grid layout', w.getComputedStyle(dropzone).display === 'grid');
  check('browse instruction is a separate line',
    d.querySelector('.dropzone__subtitle').textContent.includes('or click to browse')
    && w.getComputedStyle(d.querySelector('.dropzone__subtitle')).display === 'block');
  check('dropzone provides an accessible browse action',
    dropzone.getAttribute('role') === 'button' && dropzone.getAttribute('aria-label')
    && dropzone.getAttribute('aria-describedby') === 'upload-file-help');
  check('browse action is visible in the dropzone', /Browse files/.test(d.querySelector('.dropzone__action').textContent));
  check('facts grid has three facts', d.querySelectorAll('.dz-fact').length === 3);
  check('format chips render', d.querySelectorAll('.dz-fact .tag--slate').length >= 8);
  check('picked panel starts hidden', d.querySelector('#picked-file-wrap').hidden);
}

// --- 2. Migration of stored settings --------------------------------------
console.log('2. stored-setting migration');
{
  const dom = boot({ maxSizeMB: 25 });   // old default
  check('old 25 MB default migrates to 50', dom.window.state.settings.maxSizeMB === 50);
}
{
  const dom = boot({ maxSizeMB: 95 });   // old over-cap value
  check('over-cap 95 MB migrates to 50', dom.window.state.settings.maxSizeMB === 50);
}
{
  const dom = boot({ maxSizeMB: 10 });   // deliberate lower choice
  check('deliberate 10 MB choice is kept', dom.window.state.settings.maxSizeMB === 10);
}

// --- 3. Picking a file drives the meter -----------------------------------
console.log('3. picking a file');
{
  const dom = boot(null);
  const w = dom.window, d = w.document;
  w.showView('upload');
  w.updateUploadMode();
  const small = new w.File(['x'.repeat(3 * MB)], 'Year 12 practice.pdf', { type: 'application/pdf' });
  w.pickFile(small);
  const wrap = d.querySelector('#picked-file-wrap');
  check('picked panel becomes visible', !wrap.hidden);
  check('file name shows', d.querySelector('#picked-name').textContent === 'Year 12 practice.pdf');
  check('size note mentions the limit', /3(\.\d+)? MB of 50 MB — within the limit/.test(d.querySelector('#picked-size-note').textContent),
    d.querySelector('#picked-size-note').textContent);
  check('meter bar is green and filled', d.querySelector('#picked-size-bar').className.includes('bar__fill--emerald')
    && parseInt(d.querySelector('#picked-size-bar').style.width) > 0);
  check('remove button present with label', /Remove/i.test(d.querySelector('[data-action="clear-file"]').textContent));

  // Oversized file is rejected with a clear message; the previous good file stays chosen
  const huge = new w.File(['x'.repeat(51 * MB)], 'too-big.pdf', { type: 'application/pdf' });
  const problem = w.validateFile(huge);
  check('oversized file is rejected', /maximum is 50 MB/.test(problem), problem);
  check('oversized message no longer says "raise the limit"', !/raise the limit/.test(problem), problem);
  w.pickFile(huge);
  const err = d.querySelector('#file-error');
  check('oversized pick shows the error and keeps the good file chosen',
    !err.hidden && /50 MB/.test(err.textContent) && !wrap.hidden
    && w.state.picked && w.state.picked.name === 'Year 12 practice.pdf');

  // Removing the file clears the panel completely
  w.ACTIONS['clear-file']();
  check('remove hides the panel and the selection', wrap.hidden && w.state.picked === null);
}

// --- 4. Admin sign-in modal no longer shows default credentials ------------
console.log('4. admin sign-in modal');
{
  const dom = boot(null);
  const w = dom.window, d = w.document;
  w.openAdminAuth();
  const body = d.querySelector('#admin-login-form').parentElement.textContent;
  check('no default credentials in the modal', !/peter82|petgabs82|Default credentials/i.test(body));
  check('username placeholder is neutral', d.querySelector('#aa-user').placeholder === 'Your admin username');
  w.closeModal();
  w.openHelp();
  const help = d.querySelector('.modal').textContent;
  check('help modal no longer lists default credentials', !/peter82|petgabs82/i.test(help));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
