// ═══════════════════════════════════════════════════════════
//  SYNC.JS — Arquitectura "La Nube es la Fuente de la Verdad"
//  v4 — Fix definitivo del bug de F5
//
//  Cambios v4:
//  · createClient() se instancia dentro de DOMContentLoaded,
//    evitando que el SDK procese la sesión antes de que el
//    listener de onAuthStateChange esté registrado.
//  · onAuthStateChange se registra SINCRÓNICAMENTE (sin await,
//    sin .then()) como primera instrucción después de createClient(),
//    cerrando la brecha de timing que hacía perder INITIAL_SESSION.
//  · _pullFromCloud() tiene timeout propio de 15 s para que un
//    request colgado no freeze _loginSync() silenciosamente.
//  · Logs de debug controlados por la constante DEBUG.
//
//  API pública:
//    window.Sync.notifyChange()   → llamar después de cada save()
//    window.Sync.authToggle()     → manejador del botón login/logout
//    window.Sync.recoverDraft()   → restaurar borrador desde gm_v1_borrador
// ═══════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ─────────────────────────────────────────
  //  CONFIGURACIÓN
  // ─────────────────────────────────────────
  const SUPABASE_URL      = 'https://znooeidrrqryyrytzwtz.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inpub29laWRycnFyeXlyeXR6d3R6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAwMDU5NzcsImV4cCI6MjA5NTU4MTk3N30.gswEBA5mII3b1ckPnrZSFFKJOf9Iw752DZkbdTte7SU';
  const LS_KEY            = 'gm_v1';
  const LS_DRAFT_KEY      = 'gm_v1_borrador';
  const DEBOUNCE_MS       = 3000;
  const PUSH_TIMEOUT_MS   = 20000;
  const PULL_TIMEOUT_MS   = 15000;

  // Cambiá a true para ver logs detallados en consola durante pruebas.
  // Dejalo en false para producción.
  const DEBUG = true;
  function _log(...args) { if (DEBUG) console.log('[sync]', ...args); }

  // ─────────────────────────────────────────
  //  ESTADO INTERNO
  //  _sb se inicializa dentro de _init() para garantizar que
  //  createClient() ocurra después de que el DOM esté listo.
  // ─────────────────────────────────────────
  let _sb            = null;
  let _currentUser   = null;
  let _debounceTimer = null;
  let _isSyncing     = false;

  // Evita doble disparo de _loginSync() cuando Supabase v2 emite
  // INITIAL_SESSION y SIGNED_IN casi simultáneamente (redirect OAuth).
  let _loginSyncDone = false;

  // ─────────────────────────────────────────
  //  HELPERS GENERALES
  // ─────────────────────────────────────────
  function _esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function _safeParse(str) {
    try { return JSON.parse(str); } catch { return null; }
  }

  function _reloadAppState() {
    if (typeof load === 'function' && typeof render === 'function') {
      load();
      render();
    }
  }

  // Compara dos estados ignorando _syncedAt para no generar
  // falsos conflictos cuando solo difieren los metadatos de sync.
  function _dataEqual(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    const strip = obj => { const { _syncedAt, ...rest } = obj; return JSON.stringify(rest); };
    return strip(a) === strip(b);
  }

  function _isEmpty(obj) {
    if (!obj) return true;
    const months = obj.months;
    return !months || months.length === 0;
  }

  // ─────────────────────────────────────────
  //  MODAL ASÍNCRONO
  //
  //  Solo se llama cuando el DOM está garantizadamente listo
  //  (todo ocurre dentro de _init() → DOMContentLoaded).
  //  El fallback a confirm() nativo queda como red de seguridad
  //  para errores de HTML, pero en flujo normal nunca se activa.
  //
  //  config = {
  //    icon:         string  (emoji decorativo, opcional)
  //    title:        string
  //    message:      string  (soporta <br>)
  //    detail:       string  (texto secundario, opcional)
  //    confirmText:  string  (botón primario)
  //    cancelText:   string  (botón secundario)
  //    confirmClass: string  (clase extra del botón primario)
  //    isAlert:      bool    (un solo botón "Entendido")
  //  }
  // ─────────────────────────────────────────
  function _modal(config) {
    return new Promise(resolve => {
      const ov = document.getElementById('syncModal');
      if (!ov) {
        console.error('[sync] #syncModal no encontrado en el DOM. Revisar index.html.');
        if (config.isAlert) { resolve(undefined); return; }
        resolve(confirm(config.title + '\n\n' + config.message));
        return;
      }

      const iconEl    = document.getElementById('syncModalIcon');
      const titleEl   = document.getElementById('syncModalTitle');
      const msgEl     = document.getElementById('syncModalMessage');
      const detailEl  = document.getElementById('syncModalDetail');
      const confirmEl = document.getElementById('syncModalConfirm');
      const cancelEl  = document.getElementById('syncModalCancel');

      if (iconEl)  iconEl.textContent = config.icon || '';
      if (titleEl) titleEl.textContent = config.title || '';
      if (msgEl)   msgEl.innerHTML = config.message || '';

      if (detailEl) {
        detailEl.innerHTML = config.detail || '';
        detailEl.style.display = config.detail ? '' : 'none';
      }

      if (config.isAlert) {
        confirmEl.textContent = 'Entendido';
        confirmEl.className = 'btn btn-primary';
        cancelEl.style.display = 'none';
        const newConfirm = confirmEl.cloneNode(true);
        confirmEl.replaceWith(newConfirm);
        document.getElementById('syncModalConfirm')
          .addEventListener('click', () => { _closeModal(); resolve(undefined); }, { once: true });
      } else {
        const confirmClass = config.confirmClass || 'btn-primary';
        confirmEl.textContent = config.confirmText || 'Aceptar';
        confirmEl.className = `btn ${confirmClass}`;
        cancelEl.textContent = config.cancelText || 'Cancelar';
        cancelEl.className = 'btn btn-ghost';
        cancelEl.style.display = '';

        const newConfirm = confirmEl.cloneNode(true);
        const newCancel  = cancelEl.cloneNode(true);
        confirmEl.replaceWith(newConfirm);
        cancelEl.replaceWith(newCancel);
        document.getElementById('syncModalConfirm')
          .addEventListener('click', () => { _closeModal(); resolve(true);  }, { once: true });
        document.getElementById('syncModalCancel')
          .addEventListener('click', () => { _closeModal(); resolve(false); }, { once: true });
      }

      ov.style.display = 'flex';
    });
  }

  function _closeModal() {
    const ov = document.getElementById('syncModal');
    if (ov) ov.style.display = 'none';
  }

  // ─────────────────────────────────────────
  //  UI: INDICADOR DE SINCRONIZACIÓN
  // ─────────────────────────────────────────
  function _setSyncIndicator(state) {
    const ind = document.getElementById('syncIndicator');
    if (!ind) return;

    const cfg = {
      syncing: { text: '↻ Sincronizando…', color: 'var(--muted)' },
      synced:  { text: '✓ Sincronizado',   color: 'var(--green)' },
      error:   { text: '⚠ Error de sync',  color: 'var(--red)'   },
      idle:    { text: '',                  color: 'var(--muted)' },
    }[state] || { text: '', color: 'var(--muted)' };

    ind.textContent   = cfg.text;
    ind.style.color   = cfg.color;
    ind.style.display = (_currentUser && cfg.text) ? 'inline' : 'none';
  }

  // ─────────────────────────────────────────
  //  UI: BOTÓN DE RECUPERACIÓN DE BORRADOR
  // ─────────────────────────────────────────
  function _updateDraftBtn() {
    const btn = document.getElementById('draftRecoverBtn');
    if (!btn) return;
    btn.style.display = localStorage.getItem(LS_DRAFT_KEY) ? 'inline-flex' : 'none';
  }

  // ─────────────────────────────────────────
  //  UI: BOTÓN Y ESTADO DE AUTENTICACIÓN
  // ─────────────────────────────────────────
  function _renderAuthUI(user) {
    const btn    = document.getElementById('authBtn');
    const status = document.getElementById('authStatus');
    if (!btn) return;

    if (user) {
      btn.textContent = 'Cerrar sesión';
      btn.classList.add('auth-btn--logged');
      if (status) {
        const name   = user.user_metadata?.full_name || user.email || '';
        const avatar = user.user_metadata?.avatar_url;
        status.innerHTML = avatar
          ? `<img src="${_esc(avatar)}" class="auth-avatar" alt="${_esc(name)}">`
          : `<span class="auth-name">${_esc(name.split(' ')[0])}</span>`;
        status.style.display = 'flex';
      }
    } else {
      btn.innerHTML = '<span class="auth-btn-icon">G</span>Iniciar sesión';
      btn.classList.remove('auth-btn--logged');
      if (status) status.style.display = 'none';
      _setSyncIndicator('idle');
    }

    _updateDraftBtn();
  }

  // ─────────────────────────────────────────
  //  AUTENTICACIÓN
  // ─────────────────────────────────────────
  async function _signInWithGoogle() {
    const cleanUrl = window.location.origin + window.location.pathname;
    const { error } = await _sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: cleanUrl },
    });
    if (error) console.error('[sync] OAuth error:', error.message);
  }

  function _signOut() {
    _currentUser   = null;
    _loginSyncDone = false;
    clearTimeout(_debounceTimer);
    _isSyncing = false;
    _setSyncIndicator('idle');

    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('sb-') && key.endsWith('-auth-token')) {
        localStorage.removeItem(key);
      }
    }

    _sb.auth.signOut().catch(() => {});
    setTimeout(() => window.location.reload(), 500);
  }

  function authToggle() {
    const btn = document.getElementById('authBtn');
    if (btn) btn.disabled = true;

    if (_currentUser) {
      _signOut();
    } else {
      _signInWithGoogle().finally(() => {
        if (btn) btn.disabled = false;
      });
    }
  }

  // ─────────────────────────────────────────
  //  CLOUD: LEER DESDE SUPABASE
  //
  //  Tiene timeout propio de PULL_TIMEOUT_MS (15 s).
  //  Sin esto, un request colgado freezaría _loginSync()
  //  indefinidamente sin ningún error visible en consola.
  // ─────────────────────────────────────────
  async function _pullFromCloud() {
    if (!_currentUser) return null;

    const pullPromise = _sb
      .from('finanzas')
      .select('data, updated_at')
      .eq('user_id', _currentUser.id)
      .maybeSingle();

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Pull timeout (15 s)')), PULL_TIMEOUT_MS)
    );

    try {
      const { data, error } = await Promise.race([pullPromise, timeoutPromise]);
      if (error) { console.error('[sync] Pull error:', error.message); return null; }
      return data || null;
    } catch (e) {
      console.error('[sync] Pull exception:', e.message);
      return null;
    }
  }

  // ─────────────────────────────────────────
  //  CLOUD: ESCRIBIR EN SUPABASE
  //
  //  .select('user_id').single() detecta fallos silenciosos:
  //  si RLS bloquea la escritura, PGRST116 lo expone.
  // ─────────────────────────────────────────
  async function _pushToCloud(payload) {
    if (!_currentUser) return false;

    const upsertPromise = _sb
      .from('finanzas')
      .upsert(
        {
          user_id:    _currentUser.id,
          data:       payload,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' }
      )
      .select('user_id')
      .single();

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Push timeout (20 s)')), PUSH_TIMEOUT_MS)
    );

    try {
      const { data, error } = await Promise.race([upsertPromise, timeoutPromise]);

      if (error) {
        const isRejected = error.code === 'PGRST116' || error.message?.includes('no rows');
        console.error(
          isRejected ? '[sync] Push rechazado (RLS / sin filas):' : '[sync] Push error:',
          error.message
        );
        _setSyncIndicator('error');
        return false;
      }

      if (!data) {
        console.error('[sync] Push: sin data de retorno. Posible rechazo silencioso.');
        _setSyncIndicator('error');
        return false;
      }

      _setSyncIndicator('synced');
      return true;
    } catch (e) {
      console.error('[sync] Push exception:', e.message);
      _setSyncIndicator('error');
      return false;
    }
  }

  // ─────────────────────────────────────────
  //  SINCRONIZACIÓN DE LOGIN
  // ─────────────────────────────────────────
  async function _loginSync() {
    if (_loginSyncDone) { _log('_loginSync: ya ejecutado, saliendo'); return; }
    _loginSyncDone = true;

    if (!_currentUser) return;

    _log('_loginSync: inicio');
    _setSyncIndicator('syncing');

    const localRaw  = localStorage.getItem(LS_KEY);
    const local     = localRaw ? _safeParse(localRaw) : null;

    _log('_loginSync: tirando pull...');
    const cloudRow  = await _pullFromCloud();
    const cloudData = cloudRow?.data || null;
    _log('_loginSync: pull ok. cloudData:', cloudData ? 'tiene datos' : 'vacío');

    const localEmpty = _isEmpty(local);
    const cloudEmpty = _isEmpty(cloudData);

    // ── Caso 1: nada en ningún lado ───────────────────────────────────────────
    if (localEmpty && cloudEmpty) {
      _log('_loginSync: caso 1 — ambos vacíos');
      _setSyncIndicator('synced');
      return;
    }

    // ── Caso 2: solo hay datos en la nube → pull silencioso ───────────────────
    if (localEmpty && !cloudEmpty) {
      _log('_loginSync: caso 2 — solo nube');
      localStorage.setItem(LS_KEY, JSON.stringify(cloudData));
      _reloadAppState();
      _setSyncIndicator('synced');
      return;
    }

    // ── Caso 3: solo hay datos locales → push silencioso ─────────────────────
    if (!localEmpty && cloudEmpty) {
      _log('_loginSync: caso 3 — solo local');
      const toUpload = { ...local, _syncedAt: new Date().toISOString() };
      localStorage.setItem(LS_KEY, JSON.stringify(toUpload));
      await _pushToCloud(toUpload);
      return;
    }

    // ── Caso 4: ambos iguales → alinear metadatos silenciosamente ─────────────
    if (_dataEqual(local, cloudData)) {
      _log('_loginSync: caso 4 — iguales');
      localStorage.setItem(LS_KEY, JSON.stringify(cloudData));
      _setSyncIndicator('synced');
      return;
    }

    // ── Caso 5: ambos distintos → modal de conflicto ──────────────────────────
    _log('_loginSync: caso 5 — conflicto, abriendo modal');
    const useCloud = await _modal({
      icon:         '☁',
      title:        'Tus datos no coinciden con la nube',
      message:      'Encontramos diferencias entre los datos guardados en este dispositivo y los que están en la nube.<br><br>¿Con cuál versión querés continuar?',
      detail:       'Si elegís la nube, tus datos locales se guardarán como borrador por si los necesitás más adelante.',
      confirmText:  'Usar datos de la Nube',
      cancelText:   'Mantener mis datos locales',
      confirmClass: 'btn-primary',
    });
    _log('_loginSync: modal resuelto con', useCloud);

    if (useCloud) {
      localStorage.setItem(LS_DRAFT_KEY, localRaw);
      _updateDraftBtn();
      localStorage.setItem(LS_KEY, JSON.stringify(cloudData));
      _reloadAppState();
      _setSyncIndicator('synced');
    } else {
      const toUpload = { ...local, _syncedAt: new Date().toISOString() };
      localStorage.setItem(LS_KEY, JSON.stringify(toUpload));
      _setSyncIndicator('syncing');
      await _pushToCloud(toUpload);
    }
  }

  // ─────────────────────────────────────────
  //  RECUPERACIÓN DE BORRADOR
  // ─────────────────────────────────────────
  async function recoverDraft() {
    const draftRaw = localStorage.getItem(LS_DRAFT_KEY);
    if (!draftRaw) {
      await _modal({
        icon: '📭', title: 'Sin borrador disponible',
        message: 'No hay ningún borrador guardado para recuperar.',
        isAlert: true,
      });
      return;
    }

    const confirmed = await _modal({
      icon: '⚠', title: '¿Restaurar borrador local?',
      message: 'Esto reemplazará los datos actuales (tanto locales como en la nube) con tu borrador guardado.',
      detail: 'Esta acción no se puede deshacer.',
      confirmText: 'Sí, restaurar mi borrador',
      cancelText: 'Cancelar',
      confirmClass: 'btn-danger',
    });
    if (!confirmed) return;

    const draft = _safeParse(draftRaw);
    if (!draft) {
      await _modal({
        icon: '💔', title: 'Borrador corrupto',
        message: 'El borrador guardado no se puede leer. Fue eliminado para evitar problemas futuros.',
        isAlert: true,
      });
      localStorage.removeItem(LS_DRAFT_KEY);
      _updateDraftBtn();
      return;
    }

    const toRestore = { ...draft, _syncedAt: new Date().toISOString() };
    localStorage.setItem(LS_KEY, JSON.stringify(toRestore));

    if (_currentUser) {
      _setSyncIndicator('syncing');
      const pushOk = await _pushToCloud(toRestore);

      if (!pushOk) {
        await _modal({
          icon: '⚠', title: 'No se pudo sincronizar',
          message: 'Tu borrador se restauró localmente, pero no se pudo guardar en la nube.<br><br>Tus datos locales están seguros. Intentá de nuevo más tarde.',
          detail: 'El botón "Recuperar borrador" seguirá disponible hasta que la sincronización sea exitosa.',
          isAlert: true,
        });
        _updateDraftBtn();
        _reloadAppState();
        return;
      }
    }

    localStorage.removeItem(LS_DRAFT_KEY);
    _updateDraftBtn();
    _reloadAppState();

    await _modal({
      icon: '✅', title: 'Borrador restaurado',
      message: 'Tus datos fueron restaurados correctamente y guardados en la nube.',
      isAlert: true,
    });
  }

  // ─────────────────────────────────────────
  //  NOTIFICACIÓN CON DEBOUNCE
  // ─────────────────────────────────────────
  function notifyChange() {
    if (!_currentUser) return;

    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(async () => {
      if (_isSyncing) return;
      _isSyncing = true;
      try {
        const localRaw = localStorage.getItem(LS_KEY);
        if (!localRaw) return;
        const local = _safeParse(localRaw);
        if (!local) return;
        local._syncedAt = new Date().toISOString();
        localStorage.setItem(LS_KEY, JSON.stringify(local));
        _setSyncIndicator('syncing');
        await _pushToCloud(local);
      } finally {
        _isSyncing = false;
      }
    }, DEBOUNCE_MS);
  }

  // ─────────────────────────────────────────
  //  INICIALIZACIÓN
  //
  //  ORDEN CRÍTICO — no reordenar:
  //
  //  1. Esperar DOMContentLoaded (el modal necesita el DOM).
  //  2. createClient() — instanciar el SDK de Supabase.
  //  3. onAuthStateChange() — registrar el listener de forma
  //     SINCRÓNICA, en el mismo tick que createClient().
  //     Esto garantiza que ningún evento (incluido INITIAL_SESSION,
  //     que Supabase puede emitir sincrónicamente al leer el token
  //     del localStorage) se pierda por falta de listener.
  //  4. El resto del setup de UI.
  //
  //  Por qué esto resuelve el bug del F5:
  //  En versiones anteriores, createClient() vivía fuera del guard
  //  de DOMContentLoaded (top-level del IIFE). El SDK leía el token
  //  del localStorage en ese momento y encolaba INITIAL_SESSION.
  //  Cuando el listener finalmente se registraba (después de un
  //  .then() asíncrono), el evento ya había sido despachado sin
  //  receptor. Resultado: _loginSync() nunca se ejecutaba en F5.
  // ─────────────────────────────────────────
  function _init() {
    function _domReady() {
      return new Promise(resolve => {
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', resolve, { once: true });
        } else {
          // DOM ya listo: resolver en la próxima microtask para no
          // bloquear el hilo sincrónico actual del parser.
          resolve();
        }
      });
    }

    _domReady().then(() => {
      _log('DOM listo');

      // ── PASO 2: Instanciar cliente ────────────────────────────────────────
      _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

      // ── PASO 3: Registrar listener SINCRÓNICAMENTE ────────────────────────
      // No hay await ni .then() entre createClient() y onAuthStateChange().
      // Ambas llamadas ocurren en el mismo tick de JS, sin ceder el hilo.
      // Cualquier evento que el SDK emita (incluido INITIAL_SESSION síncronico)
      // encontrará el listener ya registrado.
      _sb.auth.onAuthStateChange(async (event, session) => {
        _log('onAuthStateChange:', event, session?.user?.email ?? 'sin usuario');
        _currentUser = session?.user || null;
        _renderAuthUI(_currentUser);

        if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') {
          if (_currentUser) {
            await _loginSync();
          } else {
            _setSyncIndicator('idle');
          }
        } else if (event === 'SIGNED_OUT') {
          _loginSyncDone = false;
          _setSyncIndicator('idle');
        }
        // TOKEN_REFRESHED y USER_UPDATED: ignorados intencionalmente.
      });

      // ── PASO 4: Setup de UI inicial ───────────────────────────────────────
      _updateDraftBtn();
    });
  }

  _init();

  // ─────────────────────────────────────────
  //  API PÚBLICA
  // ─────────────────────────────────────────
  window.Sync = {
    notifyChange: notifyChange,
    authToggle:   authToggle,
    recoverDraft: recoverDraft,
  };

})();