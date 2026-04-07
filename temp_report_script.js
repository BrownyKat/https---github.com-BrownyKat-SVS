
  let selType_ = '', selSev_ = '';
  let panicNum = '';
  let reportPhotoData = '';
  const MAP_MIN_ZOOM = 6;
  const MAP_MAX_ZOOM = 20;
  const MAP_STREET_ZOOM = 17;
  const MAPANDAN_DEFAULT = { query: 'Mapandan, Pangasinan', lat: 16.0249, lng: 120.4541, zoom: 14 };
  const mapState = { lat: null, lng: null, zoom: 16, view: 'map' };
  const MAP_TYPE_CODES = { map: 'm', satellite: 'k' };
  const API_TIMEOUT_MS = 15000;
  const PENDING_KEY = 'svs_pending_reports_v1';
  const fy = document.getElementById('footerYear');
  if (fy) fy.textContent = String(new Date().getFullYear());
  try { panicNum = localStorage.getItem('mdrrmo_panic') || ''; } catch(e) {}
  panicNum = toIntlPhone(panicNum) || '';
  bindInputSecurity();
  initReportInteractiveControls();
  bindRequiredFieldWatchers();
  flushPendingQueue();
  updatePendingCount();
  renderReportProgress();
  window.addEventListener('online', flushPendingQueue);
  if (panicNum) {
    initPanicUI();
    const mainContact = document.getElementById('iContact');
    if (mainContact && !mainContact.value) mainContact.value = formatPhoneForDisplay(panicNum);
    const sosField = document.getElementById('iPanicContact');
    const sosBtn = document.getElementById('btnSavePanic');
    const status = document.getElementById('panicSavedStatus');
    if (sosField) {
      sosField.value = formatPhoneForDisplay(panicNum);
      sosField.disabled = true;
    }
    if (sosBtn) sosBtn.textContent = 'Edit';
    if (status) { status.textContent = 'Saved'; status.style.color = 'var(--green)'; }
  }
  renderReportProgress();

  function bindInputSecurity() {
    const contactInput = document.getElementById('iContact');
    const panicInput = document.getElementById('panicInput');
    const sosField = document.getElementById('iPanicContact');
    [contactInput, panicInput].forEach(el => {
      if (!el) return;
      el.addEventListener('input', () => {
        const clean = formatPhoneForDisplay(el.value);
        if (el.value !== clean) el.value = clean;
      });
      el.addEventListener('blur', () => {
        const clean = formatPhoneForDisplay(el.value);
        if (el.value !== clean) el.value = clean;
      });
      el.addEventListener('paste', evt => {
        evt.preventDefault();
        const pasted = (evt.clipboardData || window.clipboardData).getData('text');
        el.value = formatPhoneForDisplay(pasted);
      });
    });
    if (sosField) {
      sosField.addEventListener('input', () => {
        const clean = formatPhoneForDisplay(sosField.value);
        if (sosField.value !== clean) sosField.value = clean;
      });
      sosField.addEventListener('paste', evt => {
        evt.preventDefault();
        const pasted = (evt.clipboardData || window.clipboardData).getData('text');
        sosField.value = formatPhoneForDisplay(pasted);
      });
    }
  }

  function setSelectedButton(buttons, activeButton) {
    buttons.forEach((btn) => {
      const isActive = btn === activeButton;
      btn.classList.toggle('sel', isActive);
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
  }

  function selectEmergencyType(value, sourceButton = null) {
    const normalized = String(value || '').trim();
    if (!normalized) return;
    selType_ = normalized;
    const hidden = document.getElementById('iType');
    if (hidden) hidden.value = normalized;
    const buttons = Array.from(document.querySelectorAll('.etype-btn[data-emergency-type]'));
    const active = sourceButton || buttons.find((btn) => btn.dataset.emergencyType === normalized) || null;
    setSelectedButton(buttons, active);
    setRequiredError(document.getElementById('typeGrid'), false);
    renderReportProgress();
  }

  function selectSeverity(value, sourceButton = null) {
    const normalized = String(value || '').trim();
    if (!normalized) return;
    selSev_ = normalized;
    const hidden = document.getElementById('iSev');
    if (hidden) hidden.value = normalized;
    const buttons = Array.from(document.querySelectorAll('.sev-btn[data-severity]'));
    const active = sourceButton || buttons.find((btn) => btn.dataset.severity === normalized) || null;
    setSelectedButton(buttons, active);
    setRequiredError(document.getElementById('sevGrid'), false);
    renderReportProgress();
  }

  function initReportInteractiveControls() {
    const typeGrid = document.getElementById('typeGrid');
    if (typeGrid && !typeGrid.dataset.bound) {
      typeGrid.dataset.bound = '1';
      typeGrid.addEventListener('click', (event) => {
        const btn = event.target.closest('.etype-btn[data-emergency-type]');
        if (!btn) return;
        event.preventDefault();
        selectEmergencyType(btn.dataset.emergencyType, btn);
      });
    }

    const sevGrid = document.getElementById('sevGrid');
    if (sevGrid && !sevGrid.dataset.bound) {
      sevGrid.dataset.bound = '1';
      sevGrid.addEventListener('click', (event) => {
        const btn = event.target.closest('.sev-btn[data-severity]');
        if (!btn) return;
        event.preventDefault();
        selectSeverity(btn.dataset.severity, btn);
      });
    }

    const gpsBtn = document.getElementById('gpsBtn');
    if (gpsBtn && !gpsBtn.dataset.bound) {
      gpsBtn.dataset.bound = '1';
      gpsBtn.addEventListener('click', (event) => {
        event.preventDefault();
        void detectGPS();
      });
    }
  }

  function toIntlPhone(v) {
    const digits = String(v || '').replace(/\D/g, '');
    if (/^09\d{9}$/.test(digits)) return `+63${digits.slice(1)}`;
    if (/^63\d{10}$/.test(digits)) return `+${digits}`;
    if (/^9\d{9}$/.test(digits)) return `+63${digits}`;
    return null;
  }

  function formatPhoneForDisplay(v) {
    const intl = toIntlPhone(v);
    if (!intl) {
      const digits = String(v || '').replace(/\D/g, '');
      let partial = digits;
      if (partial.startsWith('0')) partial = partial.slice(1);
      else if (partial.startsWith('63')) partial = partial.slice(2);
      partial = partial.replace(/\D/g, '').slice(0, 10);
      if (!partial) return '';
      if (partial.length <= 3) return `+63 ${partial}`;
      if (partial.length <= 6) return `+63 ${partial.slice(0, 3)} ${partial.slice(3)}`;
      return `+63 ${partial.slice(0, 3)} ${partial.slice(3, 6)} ${partial.slice(6)}`;
    }
    const local = intl.slice(3); // 9XXXXXXXXX
    return `+63 ${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6, 10)}`;
  }

  function debounce(fn, wait = 250) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  function getPendingQueue() {
    try {
      const raw = localStorage.getItem(PENDING_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (_e) { return []; }
  }

  function enqueuePending(payload) {
    try {
      const arr = getPendingQueue();
      arr.push({ payload, createdAt: Date.now() });
      localStorage.setItem(PENDING_KEY, JSON.stringify(arr.slice(-50)));
      updatePendingCount();
    } catch (_e) {}
  }

  function getReportRequestTimeout(payload = {}) {
    return payload && payload.photo ? 60000 : 20000;
  }

  async function flushPendingQueue() {
    if (!navigator.onLine) return;
    let queue = getPendingQueue();
    while (queue.length) {
      const next = queue.shift();
      try {
        localStorage.setItem(PENDING_KEY, JSON.stringify(queue));
        const payload = next.payload || {};
        const { res, data: d } = await fetchJson('/api/report', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify(payload)
        }, getReportRequestTimeout(payload));
        if (!res.ok || !d || !d.success) {
          enqueuePending(payload);
          break;
        }
        toast('Sent pending report', `Queued report delivered${d.id ? ` (ID ${d.id})` : ''}.`);
      } catch (_e) {
        enqueuePending(next.payload || {});
        break;
      }
      queue = getPendingQueue();
      updatePendingCount();
    }
  }

  function updatePendingCount() {
    const el = document.getElementById('pendingCount');
    if (el) el.textContent = String(getPendingQueue().length);
  }

  function alertQueued() {
    const c = getPendingQueue().length;
    toast('Offline queue', c ? `${c} report${c>1?'s':''} will auto-send when online.` : 'No pending reports.');
  }

  function isValidPhMobile(v) {
    return /^\+639\d{9}$/.test(toIntlPhone(v) || '');
  }

  function sanitizeText(v, maxLen = 300) {
    return String(v || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
  }

  function isSafeImageDataUrl(v) {
    return /^data:image\/(png|jpe?g|webp);base64,[a-z0-9+/=]+$/i.test(String(v || '').trim());
  }

  async function fetchJson(url, options = {}, timeoutMs = API_TIMEOUT_MS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      const data = await res.json().catch(() => ({}));
      return { res, data };
    } finally {
      clearTimeout(timer);
    }
  }

  function showInvalid(el) {
    if (!el) return;
    el.style.borderColor = 'var(--red)';
    setTimeout(() => { el.style.borderColor = ''; }, 1800);
  }

  function setRequiredError(el, missing) {
    if (!el) return;
    el.classList.toggle('req-missing', !!missing);
  }

  function hasValue(el) {
    return !!String((el && el.value) || '').trim();
  }

  function getReportProgressState() {
    const name = hasValue(document.getElementById('iName'));
    const contact = !!toIntlPhone(document.getElementById('iContact')?.value || '');
    const type = !!selType_;
    const severity = !!selSev_;
    const barangay = hasValue(document.getElementById('iBarangay'));
    const landmark = hasValue(document.getElementById('iLandmark'));
    const street = hasValue(document.getElementById('iStreet'));
    const gps = !!parseGps(document.getElementById('iGPS')?.value || '');
    const details = hasValue(document.getElementById('iDesc')) || !!reportPhotoData;

    return {
      steps: [
        { id: 'progressReporter', done: name && contact, label: 'Reporter details' },
        { id: 'progressType', done: type, label: 'Emergency type' },
        { id: 'progressSeverity', done: severity, label: 'Severity level' },
        { id: 'progressLocation', done: barangay && landmark && street && gps, label: 'Location details' },
        { id: 'progressDetails', done: details, label: 'Incident details', optional: true },
      ],
      missing: [
        !name ? 'Add the reporter name.' : '',
        !contact ? 'Enter a valid callback number.' : '',
        !type ? 'Choose the emergency type.' : '',
        !severity ? 'Choose the severity level.' : '',
        !gps ? 'Detect or confirm the GPS location.' : '',
        !barangay ? 'Fill in the barangay.' : '',
        !landmark ? 'Fill in the nearest landmark.' : '',
        !street ? 'Fill in the street or approach details.' : '',
      ].filter(Boolean),
    };
  }

  function hasStartedReportInput() {
    return [
      hasValue(document.getElementById('iName')),
      !!selType_,
      !!selSev_,
      hasValue(document.getElementById('iBarangay')),
      hasValue(document.getElementById('iLandmark')),
      hasValue(document.getElementById('iStreet')),
      !!parseGps(document.getElementById('iGPS')?.value || ''),
      hasValue(document.getElementById('iDesc')),
      !!reportPhotoData,
    ].some(Boolean);
  }

  function renderReportProgress() {
    const progress = getReportProgressState();
    const requiredSteps = progress.steps.filter(step => !step.optional);
    const completeRequired = requiredSteps.filter(step => step.done).length;
    const firstMissing = requiredSteps.find(step => !step.done);
    const panel = document.getElementById('reportProgressPanel');
    const shouldShowPanel = hasStartedReportInput();

    if (panel) {
      panel.classList.toggle('is-visible', shouldShowPanel);
      panel.setAttribute('aria-hidden', shouldShowPanel ? 'false' : 'true');
    }

    progress.steps.forEach(step => {
      const el = document.getElementById(step.id);
      if (!el) return;
      el.classList.remove('is-complete', 'is-current', 'is-missing');
      if (step.done) el.classList.add('is-complete');
      else if (!step.optional && firstMissing && firstMissing.id === step.id) el.classList.add('is-current', 'is-missing');
    });

    const progressText = document.getElementById('reportProgressText');
    const progressCount = document.getElementById('reportProgressCount');
    if (progressText) {
      progressText.textContent = progress.missing.length
        ? 'Finish the missing required sections before sending.'
        : progress.steps[4].done
          ? 'All required sections are ready and extra details are included.'
          : 'All required sections are ready. You can still add more context if needed.';
    }
    if (progressCount) progressCount.textContent = `${completeRequired} / ${requiredSteps.length} ready`;

    return progress;
  }

  function scrollToFirstMissingStep(progress = getReportProgressState()) {
    const firstMissing = progress.steps.find(step => !step.done && !step.optional);
    const stepMap = {
      progressReporter: 'step-reporter',
      progressType: 'step-type',
      progressSeverity: 'step-severity',
      progressLocation: 'step-location',
    };
    const targetId = firstMissing && stepMap[firstMissing.id];
    if (!targetId) return;
    document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function bindRequiredFieldWatchers() {
    const requiredInputs = ['iName', 'iContact', 'iBarangay', 'iLandmark', 'iStreet', 'iDesc'];
    requiredInputs.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', () => {
        if (hasValue(el)) setRequiredError(el, false);
        renderReportProgress();
      });
    });
  }

  function initPanicUI() {
    const numEl = document.getElementById('savedNum');
    const pill = document.getElementById('panicPill');
    const sub = document.getElementById('panicSublabel');
    if (!numEl || !pill || !sub) return;
    numEl.textContent = formatPhoneForDisplay(panicNum);
    pill.style.display = 'inline-flex';
    sub.innerHTML = '<strong>One tap sends instant SOS.</strong><br>Your exact location will be sent to dispatchers immediately.';
  }

  // Draft saving removed to simplify flow and avoid stale local data.

  
  // Draft helper functions removed.
  function bytesToReadableSize(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    if (value >= 1024) return `${Math.round(value / 1024)} KB`;
    return `${value} B`;
  }

  function shortenFileName(name, maxLen = 42) {
    const value = String(name || '').trim();
    if (!value || value.length <= maxLen) return value || 'Selected image';
    const dot = value.lastIndexOf('.');
    if (dot <= 0 || dot === value.length - 1) {
      return `${value.slice(0, maxLen - 3)}...`;
    }
    const ext = value.slice(dot);
    const base = value.slice(0, dot);
    const keep = Math.max(12, maxLen - ext.length - 3);
    return `${base.slice(0, keep)}...${ext}`;
  }

  function updateReportPhotoUi(file = null) {
    const meta = document.getElementById('uploadMeta');
    const thumb = document.getElementById('uploadThumb');
    const nameEl = document.getElementById('uploadFileName');

    if (!meta || !thumb || !nameEl) return;

    if (!file || !reportPhotoData) {
      meta.classList.remove('show');
      thumb.removeAttribute('src');
      nameEl.textContent = 'No file selected';
      return;
    }

    meta.classList.add('show');
    thumb.src = reportPhotoData;
    nameEl.textContent = shortenFileName(file.name, 42);
    nameEl.title = file.name || 'Selected image';
  }

  function clearReportPhoto() {
    reportPhotoData = '';
    const photoInput = document.getElementById('iPhoto');
    if (photoInput) photoInput.value = '';
    updateReportPhotoUi();
    renderReportProgress();
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.onerror = () => reject(new Error('file_read_failed'));
      reader.readAsDataURL(file);
    });
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image_decode_failed'));
      img.src = dataUrl;
    });
  }

  async function compressReportPhoto(file) {
    const originalDataUrl = await readFileAsDataUrl(file);
    if (!originalDataUrl) throw new Error('file_read_failed');

    const image = await loadImage(originalDataUrl);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return originalDataUrl;

    const MAX_DIMENSION = 1600;
    const MAX_BYTES = 900 * 1024;
    const scale = Math.min(1, MAX_DIMENSION / Math.max(image.width || 1, image.height || 1));
    canvas.width = Math.max(1, Math.round((image.width || 1) * scale));
    canvas.height = Math.max(1, Math.round((image.height || 1) * scale));
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    const mimeType = /image\/png/i.test(file.type) ? 'image/jpeg' : (file.type || 'image/jpeg');
    let quality = mimeType === 'image/jpeg' || mimeType === 'image/webp' ? 0.88 : undefined;
    let best = canvas.toDataURL(mimeType, quality);

    while (best.length * 0.75 > MAX_BYTES && quality && quality > 0.45) {
      quality -= 0.08;
      best = canvas.toDataURL(mimeType, quality);
    }

    if (best.length * 0.75 > MAX_BYTES) {
      best = canvas.toDataURL('image/jpeg', 0.72);
    }

    return best.length < originalDataUrl.length ? best : originalDataUrl;
  }

  async function handleReportPhotoChange(event) {
    const input = event?.target;
    const file = input?.files?.[0];

    if (!file) {
      clearReportPhoto();
      return;
    }

    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
      clearReportPhoto();
      toast('Unsupported photo', 'Please upload a JPG, PNG, or WEBP image.','warn');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      clearReportPhoto();
      toast('Photo too large', 'Please choose an image that is 10 MB or smaller.','warn');
      return;
    }

    try {
      reportPhotoData = await compressReportPhoto(file);
      updateReportPhotoUi(file);
      renderReportProgress();
      if (reportPhotoData && reportPhotoData.length * 0.75 > 1024 * 1024) {
        toast('Photo optimized', 'The image was compressed to improve Vercel upload reliability.','info');
      }
    } catch (_err) {
      clearReportPhoto();
      toast('Upload failed', 'The selected image could not be read. Please try another file.','warn');
    }
  }

  async function submitReport() {
    const submitBtn = document.querySelector('.submit-btn');
    const nameInput = document.getElementById('iName');
    const contactInput = document.getElementById('iContact');
    const barangayInput = document.getElementById('iBarangay');
    const landmarkInput = document.getElementById('iLandmark');
    const streetInput = document.getElementById('iStreet');
    const descInput = document.getElementById('iDesc');

    const name = sanitizeText(nameInput.value, 80);
    const contact = toIntlPhone(contactInput.value) || '';
    const barangay = sanitizeText(barangayInput.value, 80);
    const landmark = sanitizeText(landmarkInput.value, 120);
    const street = sanitizeText(streetInput.value, 120);
    const description = sanitizeText(descInput.value, 600);

    nameInput.value = name;
    contactInput.value = formatPhoneForDisplay(contact);
    barangayInput.value = barangay;
    landmarkInput.value = landmark;
    streetInput.value = street;
    descInput.value = description;

    setRequiredError(nameInput, !name);
    setRequiredError(contactInput, !contact);
    setRequiredError(document.getElementById('typeGrid'), !selType_);
    setRequiredError(document.getElementById('sevGrid'), !selSev_);
    setRequiredError(barangayInput, !barangay);
    setRequiredError(landmarkInput, !landmark);
    setRequiredError(streetInput, !street);

    if (!name||!contact||!selType_||!selSev_||!barangay||!landmark||!street) {
      const progress = renderReportProgress();
      scrollToFirstMissingStep(progress);
      toast('Missing fields', 'Please complete all required fields and selections.','warn'); return;
    }
    if (!isValidPhMobile(contact)) {
      showInvalid(contactInput);
      toast('Invalid number', 'Use a valid PH mobile number (e.g. +63 917 123 4567 or 09171234567).','warn');
      return;
    }

    // Always try to refresh GPS right before sending report for better accuracy.
    const liveGps = await tryGetLiveGps(12000);
    const gpsValue = liveGps || document.getElementById('iGPS').value;
    if (!parseGps(gpsValue)) {
      setRequiredError(document.getElementById('gpsBtn'), true);
      const progress = renderReportProgress();
      scrollToFirstMissingStep(progress);
      toast('Location required', 'Please enable Location/GPS and try again.','warn');
      return;
    }
    setRequiredError(document.getElementById('gpsBtn'), false);

    try {
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.style.opacity = '.7';
      }
      const payload = { name, contact, emergencyType: selType_, severity: selSev_, barangay, landmark, street, description, gps: gpsValue, photo: reportPhotoData || '' };
      if (!navigator.onLine) {
        enqueuePending(payload);
        toast('Saved offline', 'Will auto-send when you reconnect.');
        resetForm();
        window.dispatchEvent(new Event('svs:report-submitted'));
        return;
      }
      const { res, data: d } = await fetchJson('/api/report', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(payload)
      }, getReportRequestTimeout(payload));
      if (!res.ok || !d.success) {
        enqueuePending(payload);
        toast('Stored to retry', d.error || 'Network issue. Will retry automatically.','warn');
        return;
      }
      try{ localStorage.setItem('svs_last_report_id', d.id || ''); }catch(_e){}
      document.getElementById('rptId').textContent = d.id;
      document.getElementById('trackReportLink').href = `/track?id=${encodeURIComponent(d.id)}`;
      document.getElementById('successOverlay').classList.add('show');
      resetForm();
      window.dispatchEvent(new Event('svs:report-submitted'));
      flushPendingQueue();
      updatePendingCount();
    } catch(e) {
      enqueuePending({ name, contact, emergencyType: selType_, severity: selSev_, barangay, landmark, street, description, gps: gpsValue, photo: reportPhotoData || '' });
      toast('Stored to retry', 'Network error. Will retry when back online.','warn');
      updatePendingCount();
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.style.opacity = '';
      }
    }
  }

  function resetForm() {
    ['iName','iContact','iLandmark','iStreet','iDesc','iGPS','iGPSAt','iGPSAcc'].forEach(id => document.getElementById(id).value='');
    document.getElementById('iBarangay').value='';
    clearReportPhoto();
    document.querySelectorAll('.etype-btn').forEach(b=>b.classList.remove('sel'));
    document.querySelectorAll('.sev-btn').forEach(b=>b.classList.remove('sel'));
    document.querySelectorAll('.etype-btn,.sev-btn').forEach(b=>b.setAttribute('aria-pressed', 'false'));
    selType_=''; selSev_='';
    document.getElementById('iType').value='';
    document.getElementById('iSev').value='';
    const g=document.getElementById('gpsBtn');
    g.classList.remove('got'); g.disabled=false;
    resetMapToDefaultView();
    g.innerHTML=`<svg viewBox="0 0 24 24" style="width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round"><path d="M9.348 14.651a3.75 3.75 0 0 1 0-5.303m5.304-.001a3.75 3.75 0 0 1 0 5.304m-7.425 2.122a6.75 6.75 0 0 1 0-9.546m9.546 0a6.75 6.75 0 0 1 0 9.546M5.106 18.894c-3.808-3.808-3.808-9.98 0-13.789m13.788 0c3.808 3.808 3.808 9.981 0 13.79M12 12h.008v.007H12V12Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z"/></svg> Auto-detect My Location (GPS)`;
    updatePendingCount();
    renderReportProgress();
  }

  function closeSuccess() { document.getElementById('successOverlay').classList.remove('show'); }

  // panic
  function openPanicSetup() {
    document.getElementById('panicInput').value = formatPhoneForDisplay(panicNum);
    document.getElementById('panicModal').classList.add('show');
    setTimeout(()=>document.getElementById('panicInput').focus(),150);
  }
  function closePanicModal() { document.getElementById('panicModal').classList.remove('show'); }
  function savePanic() {
    const panicInputEl = document.getElementById('panicInput');
    const n = toIntlPhone(panicInputEl.value) || '';
    panicInputEl.value = formatPhoneForDisplay(n);
    if (!isValidPhMobile(n)) {
      showInvalid(panicInputEl);
      toast('Invalid number', 'Use a valid PH mobile number (e.g. +63 917 123 4567 or 09171234567).','warn');
      return;
    }
    panicNum = n;
    try { localStorage.setItem('mdrrmo_panic', n); } catch(e) {}
    closePanicModal(); initPanicUI();
    toast('Panic Button Ready', 'Number saved. One tap = instant SOS.');
  }
  function savePanicNumber() {
    const field = document.getElementById('iPanicContact');
    const btn = document.getElementById('btnSavePanic');
    const status = document.getElementById('panicSavedStatus');
    if (!field) return;

    if (field.disabled) {
      field.disabled = false;
      field.focus();
      if(btn) btn.textContent = 'Save SOS';
      if(status) status.textContent = '';
      return;
    }

    const n = toIntlPhone(field.value) || '';
    field.value = formatPhoneForDisplay(n);
    if (!isValidPhMobile(n)) {
      showInvalid(field);
      toast('Invalid number', 'Use a valid PH mobile number (e.g. +63 917 123 4567).','warn');
      return;
    }
    panicNum = n;
    try { localStorage.setItem('mdrrmo_panic', n); } catch(_e) {}

    if (status) { status.textContent = 'Saved'; status.style.color = 'var(--green)'; }
    field.disabled = true;
    if(btn) btn.textContent = 'Edit';
    toast('SOS number saved', 'One-tap panic will use this number.');
    const mainContact = document.getElementById('iContact');
    if (mainContact && !mainContact.value) mainContact.value = formatPhoneForDisplay(n);
  }
  function triggerPanic() {
    if (!panicNum) { openPanicSetup(); return; }
    document.getElementById('sendingState').style.display='flex';
    document.getElementById('confirmedState').classList.remove('show');
    document.getElementById('sendingOverlay').classList.add('show');
    const send = async loc => {
      const payload = {
        contact: panicNum,
        gps: loc.gps || 'unavailable',
        barangay: loc.barangay || '',
        landmark: loc.landmark || '',
        street: loc.street || '',
      };
      try {
        const { res, data: d } = await fetchJson('/api/panic',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
        if (!res.ok || !d.success) throw new Error(d.error || 'panic send failed');
        document.getElementById('sendingState').style.display='none';
        document.getElementById('sosId').textContent = d.id;
        document.getElementById('gpsNote').textContent = loc.locationText || 'Location unavailable - dispatcher will call you';
        document.getElementById('confirmedState').classList.add('show');
      } catch(e) { closeSending(); toast('Error','Could not send SOS.','warn'); }
    };

    const fallbackGps = document.getElementById('iGPS').value || '';
    const fallbackGpsAt = Number(document.getElementById('iGPSAt').value || 0);
    const fallbackGpsAcc = Number(document.getElementById('iGPSAcc').value || 99999);
    const FALLBACK_MAX_AGE_MS = 2 * 60 * 1000; // 2 minutes
    const FALLBACK_MAX_ACC_M = 200; // reject very coarse locations
    const sendWithFallback = async () => {
      const ageOk = fallbackGpsAt > 0 && (Date.now() - fallbackGpsAt) <= FALLBACK_MAX_AGE_MS;
      const accOk = Number.isFinite(fallbackGpsAcc) && fallbackGpsAcc <= FALLBACK_MAX_ACC_M;
      if (parseGps(fallbackGps) && ageOk && accOk) {
        renderReporterMap(fallbackGps, 'Panic SOS location');
        const loc = await buildPanicLocationPayload(fallbackGps);
        await send(loc);
      } else {
        await send({ gps: 'unavailable', barangay: '', landmark: '', street: '', locationText: 'Location unavailable - dispatcher will call you' });
      }
    };

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        async p => {
          const gps = `${p.coords.latitude.toFixed(5)}, ${p.coords.longitude.toFixed(5)}`;
          document.getElementById('iGPS').value = gps;
          document.getElementById('iGPSAt').value = String(Date.now());
          document.getElementById('iGPSAcc').value = String(Math.round(p.coords.accuracy || 0));
          renderReporterMap(gps, 'Panic SOS location');
          const loc = await buildPanicLocationPayload(gps);
          await send(loc);
        },
        () => { void sendWithFallback(); },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    } else { void sendWithFallback(); }
  }
  function closeSending() { document.getElementById('sendingOverlay').classList.remove('show'); }

  function toast(title, msg, type='info') {
    const t=document.getElementById('toast');
    document.getElementById('toastTitle').textContent=title;
    document.getElementById('toastMsg').textContent=msg;
    t.style.borderLeftColor = type==='warn' ? 'var(--orange)' : 'var(--green)';
    t.classList.add('show');
    setTimeout(()=>t.classList.remove('show'),3600);
  }

  // add spin keyframe
  const s=document.createElement('style');
  s.textContent='@keyframes spin{to{transform:rotate(360deg)}}';
  document.head.appendChild(s);

  function renderReporterMap(gps, label = 'Detected location') {
    const p = parseGps(gps);
    const wrap = document.getElementById('gpsMapWrap');
    const labelEl = document.getElementById('gpsMapLabel');
    if (!p || !wrap || !labelEl) return;
    mapState.lat = p.lat;
    mapState.lng = p.lng;
    mapState.zoom = Math.max(MAP_STREET_ZOOM, mapState.zoom || MAP_STREET_ZOOM);
    wrap.style.display = 'block';
    labelEl.textContent = `${label}: ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
    if (mapState.zoom < MAP_MIN_ZOOM) mapState.zoom = MAP_MIN_ZOOM;
    if (mapState.zoom > MAP_MAX_ZOOM) mapState.zoom = MAP_MAX_ZOOM;
    refreshMapFrame();
  }

  function refreshMapLink() {
    const link = document.getElementById('gpsMapLink');
    if (!link) return;
    if (!mapState.lat) {
      link.href = `https://www.google.com/maps?q=${encodeURIComponent(MAPANDAN_DEFAULT.query)}`;
      return;
    }
    const type = mapState.view === 'satellite' ? MAP_TYPE_CODES.satellite : MAP_TYPE_CODES.map;
    link.href = `https://www.google.com/maps?q=${mapState.lat.toFixed(6)},${mapState.lng.toFixed(6)}&t=${type}`;
  }

  function refreshMapFrame() {
    const frame = document.getElementById('gpsMapFrame');
    const labelEl = document.getElementById('gpsMapLabel');
    if (!frame) return;
    if (!mapState.lat) {
      if (labelEl) labelEl.textContent = 'Mapandan, Pangasinan overview';
      const src = toCenterEmbedUrl(MAPANDAN_DEFAULT.lat, MAPANDAN_DEFAULT.lng, mapState.view, mapState.zoom);
      if (frame.src !== src) frame.src = src;
      updateZoomDisplay();
      updateZoomButtons();
      updateViewToggle();
      updateMapPin();
      refreshMapLink();
      return;
    }
    const src = toEmbedUrl(mapState.lat, mapState.lng, mapState.view, mapState.zoom);
    if (frame.src !== src) frame.src = src;
    updateZoomDisplay();
    updateZoomButtons();
    updateViewToggle();
    updateMapPin();
    refreshMapLink();
  }

  function updateMapPin() {
    const pin = document.getElementById('gpsMapPin');
    const badge = document.getElementById('gpsMapBadge');
    const coords = document.getElementById('gpsMapCoords');
    const hasLocation = Number.isFinite(mapState.lat) && Number.isFinite(mapState.lng);
    if (pin) pin.hidden = !hasLocation;
    if (badge) badge.hidden = !hasLocation;
    if (coords && hasLocation) {
      coords.textContent = `${mapState.lat.toFixed(5)}, ${mapState.lng.toFixed(5)}`;
    }
  }

  function updateViewToggle() {
    const toggle = document.getElementById('gpsMapViewToggle');
    if (!toggle) return;
    const showingSatellite = mapState.view === 'satellite';
    toggle.textContent = showingSatellite ? 'Show standard map' : 'Show satellite image';
    toggle.classList.toggle('active', showingSatellite);
    toggle.disabled = !mapState.lat;
  }

  function updateZoomDisplay() {
    const label = document.getElementById('gpsMapZoomValue');
    if (label) label.textContent = `${mapState.zoom}x`;
  }

  function updateZoomButtons() {
    const zoomOut = document.getElementById('gpsMapZoomOut');
    const zoomIn = document.getElementById('gpsMapZoomIn');
    if (zoomOut) zoomOut.disabled = !mapState.lat || mapState.zoom <= MAP_MIN_ZOOM;
    if (zoomIn) zoomIn.disabled = !mapState.lat || mapState.zoom >= MAP_MAX_ZOOM;
  }

  function resetMapToDefaultView() {
    mapState.lat = null;
    mapState.lng = null;
    mapState.zoom = MAPANDAN_DEFAULT.zoom;
    mapState.view = 'map';
    refreshMapFrame();
  }

  function changeMapZoom(delta) {
    if (!mapState.lat) return;
    const nextZoom = Math.min(MAP_MAX_ZOOM, Math.max(MAP_MIN_ZOOM, mapState.zoom + delta));
    if (nextZoom === mapState.zoom) return;
    mapState.zoom = nextZoom;
    refreshMapFrame();
  }

  function toggleMapView() {
    if (!mapState.lat) return;
    mapState.view = mapState.view === 'satellite' ? 'map' : 'satellite';
    refreshMapFrame();
  }

  document.getElementById('gpsMapViewToggle')?.addEventListener('click', toggleMapView);
  document.getElementById('gpsMapZoomIn')?.addEventListener('click', () => changeMapZoom(1));
  document.getElementById('gpsMapZoomOut')?.addEventListener('click', () => changeMapZoom(-1));
  updateZoomDisplay();
  updateZoomButtons();
  updateViewToggle();
  resetMapToDefaultView();

  function normText(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function pickFirst(parts) {
    for (const p of parts) {
      if (p && String(p).trim()) return String(p).trim();
    }
    return '';
  }

  function maybeSetBarangay(detected) {
    const raw = String(detected || '').trim();
    if (!raw) return false;

    const inp = document.getElementById('iBarangay');
    if (!inp || inp.value.trim()) return false;
    const target = raw.replace(/^brgy\.?\s*/i, 'Barangay ').trim();
    inp.value = target;
    return true;
  }

  function maybeSetLandmark(detected) {
    const text = String(detected || '').trim();
    if (!text) return false;
    const inp = document.getElementById('iLandmark');
    if (inp.value.trim()) return false;
    inp.value = text;
    return true;
  }

  async function reverseGeocode(lat, lng) {
    const url = `/api/reverse-geocode?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`;
    try {
      const { res: r, data: j } = await fetchJson(url, {}, 12000);
      if (r.ok) {
        return {
          barangay: String((j && j.barangay) || '').trim(),
          landmark: String((j && j.landmark) || '').trim(),
          street: String((j && j.street) || '').trim(),
        };
      }
    } catch (_e) {}

    return { barangay: '', landmark: '', street: '' };
  }

  async function buildPanicLocationPayload(gps) {
    const p = parseGps(gps);
    if (!p) {
      return { gps: 'unavailable', barangay: '', landmark: '', street: '', locationText: 'Location unavailable - dispatcher will call you' };
    }

    const info = await reverseGeocode(p.lat, p.lng);
    const barangay = info.barangay || '';
    const street = info.street || '';
    const landmark = info.landmark || `Near ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
    const locationText = pickFirst([
      [street, landmark, barangay].filter(Boolean).join(', '),
      [landmark, barangay].filter(Boolean).join(', '),
      `GPS ${gps}`,
    ]);

    return {
      gps,
      barangay,
      landmark,
      street,
      locationText: `Location sent: ${locationText}`,
    };
  }

  async function autoFillLocationFromCoords(lat, lng) {
    const info = await reverseGeocode(lat, lng);
    const fallbackLandmark = `Near ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    const changedBarangay = maybeSetBarangay(info.barangay || '');
    const changedLandmark = maybeSetLandmark(info.landmark ? `Near ${info.landmark}` : fallbackLandmark);
    if (changedBarangay || changedLandmark) {
      toast('Location autofill', 'Barangay/Landmark populated from detected GPS.');
    }
  }

  async function tryGetLiveGps(timeoutMs = 12000) {
    if (!navigator.geolocation) return null;
    return new Promise(resolve => {
      navigator.geolocation.getCurrentPosition(
        pos => {
          const gps = `${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`;
          document.getElementById('iGPS').value = gps;
          document.getElementById('iGPSAt').value = String(Date.now());
          document.getElementById('iGPSAcc').value = String(Math.round(pos.coords.accuracy || 0));
          renderReporterMap(gps, 'Detected location');
          void autoFillLocationFromCoords(pos.coords.latitude, pos.coords.longitude);
          setRequiredError(document.getElementById('gpsBtn'), false);
          resolve(gps);
        },
        () => resolve(null),
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 }
      );
    });
  }

  // GPS accuracy + repeat-detect overrides
  async function detectGPS() {
    const btn = document.getElementById('gpsBtn');
    if (!btn) return;
    if (btn.disabled) return;
    btn.disabled = true;
    btn.innerHTML = `<svg viewBox="0 0 24 24" style="width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round;animation:spin .9s linear infinite"><path d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"/></svg> Detecting...`;
    if (!window.isSecureContext) {
      btn.textContent = 'GPS needs HTTPS or localhost';
      toast('Location unavailable', 'Geolocation only works on HTTPS or localhost.', 'warn');
      btn.disabled = false;
      return;
    }
    if (!navigator.geolocation) {
      btn.textContent = 'GPS not available on this device';
      toast('Location unavailable', 'This browser or device does not support geolocation.', 'warn');
      btn.disabled = false;
      return;
    }
    try {
      if (navigator.permissions && typeof navigator.permissions.query === 'function') {
        const status = await navigator.permissions.query({ name: 'geolocation' });
        if (status && status.state === 'denied') {
          btn.textContent = 'Location permission blocked';
          toast('Location blocked', 'Enable location permission for this site in your browser settings.', 'warn');
          return;
        }
      }
    } catch (_err) {}
    try {
      const pos = await acquireBestGpsPosition(14000, 25);
      if (!pos) {
        btn.textContent = 'Could not detect location - fill in manually.';
        toast('Location timeout', 'We could not get a GPS fix. Check permission, signal, or try outdoors.', 'warn');
        return;
      }
      await applyDetectedCoords(pos, { overwriteExisting: true });
      setRequiredError(btn, false);
      btn.classList.add('got');
      btn.innerHTML = `<svg viewBox="0 0 24 24" style="width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><path d="M4.5 12.75l6 6 9-13.5"/></svg> Detected: ${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)} (+/-${Math.round(pos.coords.accuracy || 0)}m)`;
    } catch (err) {
      btn.textContent = 'Could not detect location - fill in manually.';
      const message = err && err.message ? err.message : '';
      if (/denied/i.test(message)) {
        toast('Location blocked', 'Allow location access for this site, then try again.', 'warn');
      } else {
        toast('Location failed', 'GPS detection failed. You can still enter the location manually.', 'warn');
      }
    } finally {
      btn.disabled = false;
    }
  }

  function maybeSetBarangay(detected, overwriteExisting = false) {
    const raw = String(detected || '').trim();
    if (!raw) return false;
    const inp = document.getElementById('iBarangay');
    if (!inp) return false;
    if (!overwriteExisting && inp.value.trim()) return false;
    const target = raw.replace(/^brgy\.?\s*/i, 'Barangay ').trim();
    if (inp.value.trim() === target) return false;
    inp.value = target;
    setRequiredError(inp, false);
    return true;
  }

  function maybeSetLandmark(detected, overwriteExisting = false) {
    const text = String(detected || '').trim();
    if (!text) return false;
    const inp = document.getElementById('iLandmark');
    if (!inp) return false;
    if (!overwriteExisting && inp.value.trim()) return false;
    if (inp.value.trim() === text) return false;
    inp.value = text;
    setRequiredError(inp, false);
    return true;
  }

  function maybeSetStreet(detected, overwriteExisting = false) {
    const text = String(detected || '').trim();
    if (!text) return false;
    const inp = document.getElementById('iStreet');
    if (!inp) return false;
    if (!overwriteExisting && inp.value.trim()) return false;
    if (inp.value.trim() === text) return false;
    inp.value = text;
    setRequiredError(inp, false);
    return true;
  }

  async function autoFillLocationFromCoords(lat, lng, options = {}) {
    const overwriteExisting = !!options.overwriteExisting;
    const info = await reverseGeocode(lat, lng);
    const fallbackBarangay = pickFirst([info.barangay, 'Mapandan area']);
    const fallbackLandmark = `Near ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    const fallbackStreet = pickFirst([info.street, info.landmark, fallbackLandmark]);
    const changedBarangay = maybeSetBarangay(fallbackBarangay, overwriteExisting);
    const changedLandmark = maybeSetLandmark(info.landmark ? `Near ${info.landmark}` : fallbackLandmark, overwriteExisting);
    const changedStreet = maybeSetStreet(fallbackStreet, overwriteExisting);
    if (changedBarangay || changedLandmark || changedStreet) {
      toast('Location autofill', 'Location fields updated from detected GPS.');
    }
    renderReportProgress();
  }

  async function applyDetectedCoords(pos, options = {}) {
    if (!pos || !pos.coords) return;
    const gps = `${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`;
    document.getElementById('iGPS').value = gps;
    document.getElementById('iGPSAt').value = String(Date.now());
    document.getElementById('iGPSAcc').value = String(Math.round(pos.coords.accuracy || 0));
    mapState.zoom = Math.max(MAP_STREET_ZOOM, mapState.zoom);
    renderReporterMap(gps, 'Detected location');
    await autoFillLocationFromCoords(pos.coords.latitude, pos.coords.longitude, options);
    renderReportProgress();
  }

  async function acquireBestGpsPosition(timeoutMs = 12000, targetAccuracyM = 30) {
    if (!navigator.geolocation) return null;
    return new Promise(resolve => {
      let best = null;
      let done = false;
      let watchId = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (watchId !== null) {
          try { navigator.geolocation.clearWatch(watchId); } catch (_e) {}
        }
        resolve(best);
      };
      const onSuccess = (pos) => {
        if (!pos || !pos.coords) return;
        if (!best || Number(pos.coords.accuracy || Infinity) < Number(best.coords.accuracy || Infinity)) {
          best = pos;
        }
        if (Number(pos.coords.accuracy || Infinity) <= targetAccuracyM) finish();
      };
      const onError = () => {};

      try {
        watchId = navigator.geolocation.watchPosition(
          onSuccess,
          onError,
          { enableHighAccuracy: true, timeout: Math.min(timeoutMs, 10000), maximumAge: 0 }
        );
      } catch (_e) {}

      navigator.geolocation.getCurrentPosition(
        onSuccess,
        onError,
        { enableHighAccuracy: true, timeout: Math.min(timeoutMs, 10000), maximumAge: 0 }
      );

      setTimeout(finish, timeoutMs);
    });
  }

  async function tryGetLiveGps(timeoutMs = 12000) {
    if (!navigator.geolocation) return null;
    const pos = await acquireBestGpsPosition(timeoutMs, 30);
    if (!pos) return null;
    await applyDetectedCoords(pos, { overwriteExisting: false });
    setRequiredError(document.getElementById('gpsBtn'), false);
    return `${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`;
  }

  function updateTime(elId){
    const el=document.getElementById(elId);
    if(!el) return;
    const clock=el.querySelector('.clock-text');
    const date=el.querySelector('.date-text');
    const now=new Date();
    const pad=n=>String(n).padStart(2,'0');
    const h24=now.getHours(); const h=h24%12||12;
    const ampm=h24>=12?'PM':'AM';
    clock.textContent=`${pad(h)}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ${ampm}`;
    const days=['SUN','MON','TUE','WED','THU','FRI','SAT'];
    date.textContent=`${days[now.getDay()]} ${pad(now.getMonth()+1)}/${pad(now.getDate())}/${now.getFullYear()}`;
  }
  updateTime('reportTime'); setInterval(()=>updateTime('reportTime'),1000);

