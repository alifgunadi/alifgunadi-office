'use strict';

// ---------- settings dialog: the parent folder whose sub-folders are the workspaces ----------
// The server checks everything; this only shows what it says. The path travels in the body of a POST, never in an address.

const setDlg = document.getElementById('settings-dialog');
const setInput = document.getElementById('settings-root');
const setSource = document.getElementById('settings-source');
const setStatusEl = document.getElementById('settings-status');
const setSave = document.getElementById('settings-save');
const setReset = document.getElementById('settings-reset');
const settingsState = { info: null, valid: false, seq: 0, timer: null, opener: null, busy: false };

const SETTINGS_ERRORS = {
  not_found: 'Folder tidak ditemukan.',
  not_readable: 'Folder ini tidak bisa dibaca.',
  too_broad: 'Folder ini terlalu luas (drive, folder sistem, atau folder pengguna). Pilih folder yang berisi proyek-proyek Anda.',
  locked_by_env: 'Daftar folder dikunci oleh server (AGENT_OFFICE_WORKSPACES), jadi tidak bisa diubah dari sini.',
  not_saved: 'Pengaturan tidak bisa disimpan di komputer ini.',
  login_required: 'Masuk dulu lewat peluncur untuk mengubah pengaturan.',
  bad_request: 'Isi folder tidak valid.',
  settings_unreadable: 'Berkas pengaturan rusak atau tidak bisa dibaca, jadi tidak ada folder yang dipakai. Simpan folder baru untuk menggantinya.',
  too_many_checks: 'Terlalu banyak pemeriksaan. Tunggu sebentar.',
};
const SOURCE_TEXT = {
  ui: 'Dipilih di halaman ini.',
  env: 'Dari AGENT_OFFICE_ROOTS di server.',
  default: 'Bawaan: folder tempat aplikasi ini berada.',
  none: 'Belum ada folder induk. Pilih satu di sini supaya folder kerja muncul di dock.',
  fixed: 'Daftar folder tetap dari AGENT_OFFICE_WORKSPACES.',
};

function setStatusText(text, kind) {
  setStatusEl.textContent = text;
  setStatusEl.dataset.kind = kind || '';
  setInput.setAttribute('aria-invalid', kind === 'error' ? 'true' : 'false');
}

function settingsRefreshButtons() {
  const info = settingsState.info;
  const editable = !!info && !info.locked && session.authed;
  const changed = editable && setInput.value.trim() !== (info.root || '');
  setSave.disabled = settingsState.busy || !(changed && settingsState.valid);
  setReset.disabled = settingsState.busy || !editable || info.source !== 'ui';
}

async function settingsLoad() {
  settingsState.info = null;
  settingsState.valid = false;
  setInput.value = '';
  setInput.disabled = true;
  setSource.textContent = '';
  if (!session.authed) {
    setStatusText('Buka kantor lewat start-office.ps1 atau aplikasi desktop untuk mengubah pengaturan.', '');
    settingsRefreshButtons();
    return;
  }
  setStatusText('Memuat…', '');
  const r = await api('GET', '/settings');
  if (!setDlg.open) return;
  if (r.status !== 200 || !r.data || !r.data.root) {
    setStatusText(r.status === 401 ? SETTINGS_ERRORS.login_required : 'Server tidak bisa dihubungi.', 'error');
    settingsRefreshButtons();
    return;
  }
  const info = r.data.root;
  settingsState.info = info;
  setSource.textContent = SOURCE_TEXT[info.source] || '';
  if (info.locked) {
    setStatusText(SETTINGS_ERRORS.locked_by_env + ' ' + info.count + ' folder tersedia.', '');
  } else {
    setInput.disabled = false;
    setInput.value = info.root || '';
    if (info.error) setStatusText('Folder tersimpan: ' + (SETTINGS_ERRORS[info.error] || info.error), 'error');
    else if (info.root) setStatusText(info.count + ' folder ditemukan.', 'ok');
    else setStatusText('', '');
  }
  settingsRefreshButtons();
}

// Check what is typed, a moment after the typing stops. A late answer for an older value is dropped.
function settingsCheckSoon() {
  clearTimeout(settingsState.timer);
  settingsState.valid = false;
  settingsRefreshButtons();
  const value = setInput.value.trim();
  const info = settingsState.info;
  if (value === '' || (info && value === (info.root || ''))) {
    const same = value !== '' && info && !info.error;
    setStatusText(same ? info.count + ' folder ditemukan.' : '', same ? 'ok' : '');
    return;
  }
  setStatusText('Memeriksa…', '');
  const mine = ++settingsState.seq;
  settingsState.timer = setTimeout(async () => {
    const r = await api('POST', '/settings/check', { path: value });
    if (mine !== settingsState.seq || !setDlg.open) return;
    if (r.status === 200 && r.data && r.data.ok) {
      settingsState.valid = true;
      setStatusText(r.data.count + ' folder ditemukan.', 'ok');
    } else {
      const code = r.data && r.data.error;
      setStatusText(SETTINGS_ERRORS[code] || (r.status === 0 ? 'Server tidak bisa dihubungi.' : 'Folder tidak bisa dipakai.'), 'error');
    }
    settingsRefreshButtons();
  }, 400);
}

async function settingsApply(path) {
  settingsState.busy = true;
  settingsRefreshButtons();
  setStatusText('Menyimpan…', '');
  const r = await api('POST', '/settings/root', { path });
  settingsState.busy = false;
  if (r.status === 200 && r.data && r.data.ok) {
    session.workspaces = r.data.workspaces || [];
    if (typeof foldersChanged === 'function') foldersChanged();
    closeSettings();
    showToast(path === null ? 'Folder induk dikembalikan ke bawaan.' : 'Folder induk disimpan: ' + session.workspaces.length + ' folder.');
    return;
  }
  const code = r.data && r.data.error;
  setStatusText(SETTINGS_ERRORS[code] || (r.status === 0 ? 'Server tidak bisa dihubungi.' : 'Gagal menyimpan.'), 'error');
  settingsRefreshButtons();
}

function openSettings(opener) {
  if (setDlg.open) return;
  settingsState.opener = opener || document.getElementById('btn-settings');
  setDlg.showModal();
  settingsLoad();
  setInput.focus();
}

function closeSettings() {
  clearTimeout(settingsState.timer);
  settingsState.seq++;
  if (setDlg.open) setDlg.close();
}

setDlg.addEventListener('close', () => {
  const o = settingsState.opener;
  settingsState.opener = null;
  if (o && document.contains(o)) o.focus();
});
document.getElementById('settings-close').addEventListener('click', closeSettings);
document.getElementById('settings-cancel').addEventListener('click', closeSettings);
setReset.addEventListener('click', () => settingsApply(null));
setInput.addEventListener('input', settingsCheckSoon);
document.getElementById('settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!setSave.disabled) settingsApply(setInput.value.trim());
});
// a click on the dark backdrop closes it, a click inside does not
setDlg.addEventListener('mousedown', (e) => { if (e.target === setDlg) closeSettings(); });
