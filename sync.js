// ═══════════════════════════════════════════════════════════
//  SYNC.JS — Arquitectura "La Nube es la Fuente de la Verdad"
//  v3 — Modal asíncrono + validación de escritura en Supabase
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

  // ─────────────────────────────────────────
  //  CLIENTE SUPABASE
  // ─────────────────────────────────────────
  const _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // ─────────────────────────────────────────
  //  ESTADO INTERNO
  // ─────────────────────────────────────────
  let _currentUser   = null;
  let _debounceTimer = null;
  let _isSyncing     = false;

  // Evita doble disparo de _loginSync() por SIGNED_IN + getSession()
  // en el redirect OAuth de Supabase v2.
  let _loginSyncDone = false;

  // Flag auxiliar: se setea true en cuanto onAuthStateChange dispara por primera
  // vez (cualquier evento). Permite al fallback de _init() saber que el listener
  // ya corrió aunque el usuario no esté logueado (_currentUser sería null en
  // ambos casos: antes y después del evento).
  let _listenerFired = false;

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
  //  Reemplaza confirm() y alert() nativos.
  //  Devuelve una Promise que resuelve con:
  //    · true/false  →  para diálogos de elección (confirm)
  //    · undefined   →  para avisos (alert, un solo botón)
  //
  //  config = {
  //    icon:       string  (emoji decorativo, opcional)
  //    title:      string  (título del modal)
  //    message:    string  (párrafo explicativo, soporta <br>)
  //    detail:     string  (texto secundario más pequeño, opcional)
  //    confirmText: string (texto botón primario, opcional)
  //    cancelText:  string (texto botón secundario, opcional)
  //    confirmClass: string (clase extra para btn primario, por defecto btn-primary)
  //    isAlert:     bool   (modo alerta: un solo botón "Entendido")
  //  }
  // ─────────────────────────────────────────
  function _modal(config) {
    return new Promise(resolve => {
      const ov = document.getElementById('syncModal');
      if (!ov) {
        // Fallback defensivo si el HTML todavía no tiene el modal
        if (config.isAlert) { resolve(undefined); return; }
        resolve(confirm(config.title + '\n\n' + config.message));
        return;
      }

      // Poblar contenido
      const iconEl    = document.getElementById('syncModalIcon');
      const titleEl   = document.getElementById('syncModalTitle');
      const msgEl     = document.getElementById('syncModalMessage');
      const detailEl  = document.getElementById('syncModalDetail');
      const confirmEl = document.getElementById('syncModalConfirm');
      const cancelEl  = document.getElementById('syncModalCancel');

      if (iconEl)   iconEl.textContent  = config.icon || '';
      if (titleEl)  titleEl.textContent = config.title || '';
      if (msgEl)    msgEl.innerHTML     = config.message || '';

      if (detailEl) {
        detailEl.innerHTML    = config.detail || '';
        detailEl.style.display = config.detail ? '' : 'none';
      }

      // Modo alerta (un solo botón)
      if (config.isAlert) {
        confirmEl.textContent = 'Entendido';
        confirmEl.className   = 'btn btn-primary';
        cancelEl.style.display = 'none';
        const onConfirm = () => { _closeModal(); resolve(undefined); };
        confirmEl.replaceWith(confirmEl.cloneNode(true));
        document.getElementById('syncModalConfirm').addEventListener('click', onConfirm, { once: true });
      } else {
        // Modo confirm (dos botones)
        const confirmClass = config.confirmClass || 'btn-primary';
        confirmEl.textContent  = config.confirmText  || 'Aceptar';
        confirmEl.className    = `btn ${confirmClass}`;
        cancelEl.textContent   = config.cancelText   || 'Cancelar';
        cancelEl.className     = 'btn btn-ghost';
        cancelEl.style.display = '';

        const onConfirm = () => { _closeModal(); resolve(true);  };
        const onCancel  = () => { _closeModal(); resolve(false); };

        // Clonar para limpiar listeners anteriores
        const newConfirm = confirmEl.cloneNode(true);
        const newCancel  = cancelEl.cloneNode(true);
        confirmEl.replaceWith(newConfirm);
        cancelEl.replaceWith(newCancel);
        document.getElementById('syncModalConfirm').addEventListener('click', onConfirm, { once: true });
        document.getElementById('syncModalCancel').addEventListener('click', onCancel,  { once: true });
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
  // ─────────────────────────────────────────
  async function _pullFromCloud() {
    if (!_currentUser) return null;
    try {
      const { data, error } = await _sb
        .from('finanzas')
        .select('data, updated_at')
        .eq('user_id', _currentUser.id)
        .maybeSingle();

      if (error) { console.error('[sync] Pull error:', error.message); return null; }
      return data || null;
    } catch (e) {
      console.error('[sync] Pull exception:', e);
      return null;
    }
  }

  // ─────────────────────────────────────────
  //  CLOUD: ESCRIBIR EN SUPABASE
  //
  //  Usa { count: 'exact' } para detectar fallos silenciosos:
  //  si RLS bloquea la escritura, Supabase devuelve count === 0
  //  aunque no haya error explícito en la respuesta.
  //  Esto evita el falso positivo de "✓ Sincronizado" cuando
  //  en realidad no se guardó nada.
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
      .select('user_id')   // Hace que Supabase devuelva la fila afectada
      .single();           // Si no hubo fila afectada, dispara error PGRST116

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout de sincronización (20 s)')), PUSH_TIMEOUT_MS)
    );

    try {
      const { data, error } = await Promise.race([upsertPromise, timeoutPromise]);

      if (error) {
        // PGRST116 = "no rows returned" → la escritura fue rechazada en silencio (RLS u otro)
        const isRejected = error.code === 'PGRST116' || error.message?.includes('no rows');
        console.error(
          isRejected
            ? '[sync] Push rechazado por Supabase (RLS o sin filas afectadas):'
            : '[sync] Push error:',
          error.message
        );
        _setSyncIndicator('error');
        return false;
      }

      // Doble check: si data viene vacío a pesar de no tener error, también es fallo
      if (!data) {
        console.error('[sync] Push: Supabase no devolvió datos. Posible rechazo silencioso.');
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
  //
  //  Compara cloud vs local como bloque único (macro).
  //  Sin merge campo a campo ni mes a mes.
  // ─────────────────────────────────────────
  async function _loginSync() {
    if (_loginSyncDone) return;
    _loginSyncDone = true;

    if (!_currentUser) return;

    _setSyncIndicator('syncing');

    const localRaw  = localStorage.getItem(LS_KEY);
    const local     = localRaw ? _safeParse(localRaw) : null;
    const cloudRow  = await _pullFromCloud();
    const cloudData = cloudRow?.data || null;

    const localEmpty = _isEmpty(local);
    const cloudEmpty = _isEmpty(cloudData);

    // ── Caso 1: nada en ningún lado ───────────────────────────────────────────
    if (localEmpty && cloudEmpty) {
      _setSyncIndicator('synced');
      return;
    }

    // ── Caso 2: solo hay datos en la nube → pull silencioso ───────────────────
    if (localEmpty && !cloudEmpty) {
      localStorage.setItem(LS_KEY, JSON.stringify(cloudData));
      _reloadAppState();
      _setSyncIndicator('synced');
      return;
    }

    // ── Caso 3: solo hay datos locales → push silencioso ─────────────────────
    if (!localEmpty && cloudEmpty) {
      const toUpload = { ...local, _syncedAt: new Date().toISOString() };
      localStorage.setItem(LS_KEY, JSON.stringify(toUpload));
      await _pushToCloud(toUpload);
      return;
    }

    // ── Caso 4: ambos tienen datos pero son iguales → alinear metadatos ───────
    if (_dataEqual(local, cloudData)) {
      localStorage.setItem(LS_KEY, JSON.stringify(cloudData));
      _setSyncIndicator('synced');
      return;
    }

    // ── Caso 5: ambos tienen datos Y difieren → preguntar con modal ───────────
    const useCloud = await _modal({
      icon:         '☁',
      title:        'Tus datos no coinciden con la nube',
      message:      'Encontramos diferencias entre los datos guardados en este dispositivo y los que están en la nube.<br><br>¿Con cuál versión querés continuar?',
      detail:       'Si elegís la nube, tus datos locales se guardarán como borrador por si los necesitás más adelante.',
      confirmText:  'Usar datos de la Nube',
      cancelText:   'Mantener mis datos locales',
      confirmClass: 'btn-primary',
    });

    if (useCloud) {
      // Guardar copia de seguridad del local ANTES de pisarlo
      localStorage.setItem(LS_DRAFT_KEY, localRaw);
      _updateDraftBtn();

      localStorage.setItem(LS_KEY, JSON.stringify(cloudData));
      _reloadAppState();
      _setSyncIndicator('synced');
    } else {
      // El usuario conserva el local → push inmediato a la nube
      const toUpload = { ...local, _syncedAt: new Date().toISOString() };
      localStorage.setItem(LS_KEY, JSON.stringify(toUpload));
      _setSyncIndicator('syncing');
      await _pushToCloud(toUpload);
    }
  }

  // ─────────────────────────────────────────
  //  RECUPERACIÓN DE BORRADOR
  //
  //  Si el push falla: aborta sin eliminar el borrador.
  //  No hace window.location.reload(): usa _reloadAppState()
  //  para evitar el bloqueo de Chrome cuando hay un modal
  //  o popup pendiente al momento de la recarga.
  // ─────────────────────────────────────────
  async function recoverDraft() {
    const draftRaw = localStorage.getItem(LS_DRAFT_KEY);
    if (!draftRaw) {
      await _modal({
        icon:    '📭',
        title:   'Sin borrador disponible',
        message: 'No hay ningún borrador guardado para recuperar.',
        isAlert: true,
      });
      return;
    }

    const confirmed = await _modal({
      icon:         '⚠',
      title:        '¿Restaurar borrador local?',
      message:      'Esto reemplazará los datos actuales (tanto locales como en la nube) con tu borrador guardado.',
      detail:       'Esta acción no se puede deshacer.',
      confirmText:  'Sí, restaurar mi borrador',
      cancelText:   'Cancelar',
      confirmClass: 'btn-danger',
    });

    if (!confirmed) return;

    const draft = _safeParse(draftRaw);
    if (!draft) {
      await _modal({
        icon:    '💔',
        title:   'Borrador corrupto',
        message: 'El borrador guardado no se puede leer. Fue eliminado para evitar problemas futuros.',
        isAlert: true,
      });
      localStorage.removeItem(LS_DRAFT_KEY);
      _updateDraftBtn();
      return;
    }

    // Pisar gm_v1 con el borrador
    const toRestore = { ...draft, _syncedAt: new Date().toISOString() };
    localStorage.setItem(LS_KEY, JSON.stringify(toRestore));

    // Push a Supabase. Si falla: abortar sin eliminar el borrador.
    if (_currentUser) {
      _setSyncIndicator('syncing');
      const pushOk = await _pushToCloud(toRestore);

      if (!pushOk) {
        // Restaurar el LS_KEY al estado original y avisar
        // (el borrador permanece intacto para el próximo intento)
        await _modal({
          icon:    '⚠',
          title:   'No se pudo sincronizar',
          message: 'Tu borrador se restauró localmente, pero no se pudo guardar en la nube por un error de red o de permisos.<br><br>Tus datos locales están seguros. Intentá de nuevo más tarde.',
          detail:  'El botón "Recuperar borrador" seguirá disponible hasta que la sincronización sea exitosa.',
          isAlert: true,
        });
        // El borrador NO se elimina: el usuario puede volver a intentar
        _updateDraftBtn();
        // Recargar la UI con los datos del borrador ya pisados en localStorage
        _reloadAppState();
        return;
      }
    }

    // Push exitoso (o no había sesión): limpiar borrador y refrescar UI
    localStorage.removeItem(LS_DRAFT_KEY);
    _updateDraftBtn();
    _reloadAppState();

    await _modal({
      icon:    '✅',
      title:   'Borrador restaurado',
      message: 'Tus datos fueron restaurados correctamente y guardados en la nube.',
      isAlert: true,
    });
  }

  // ─────────────────────────────────────────
  //  NOTIFICACIÓN CON DEBOUNCE
  //
  //  Llamada desde script.js después de cada save().
  //  Solo sube; nunca dispara el modal de conflicto.
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
  //  INICIALIZACIÓN DEL MÓDULO
  //
  //  Arquitectura de fuente única de verdad:
  //  onAuthStateChange es el ÚNICO camino que llama a _loginSync().
  //  getSession() ya NO llama a _loginSync() directamente; solo
  //  actúa como fallback de UI para el caso extremo en que el
  //  evento tarde más de INIT_TIMEOUT_MS en llegar (red muy lenta
  //  o bloqueada). En ese caso renderiza la UI sin sync, y el
  //  evento llegará cuando la red se recupere.
  //
  //  Eventos que disparan _loginSync():
  //    · INITIAL_SESSION  → recarga de página (F5) con sesión activa
  //    · SIGNED_IN        → login manual / redirect OAuth
  //
  //  Eventos ignorados para _loginSync():
  //    · TOKEN_REFRESHED  → los pushes activos los cubre notifyChange()
  //    · USER_UPDATED     → cambio de perfil, no implica conflicto de datos
  // ─────────────────────────────────────────
  (async function _init() {
    _updateDraftBtn();

    // ── Fuente única: onAuthStateChange maneja TODO ───────────────────────────
    _sb.auth.onAuthStateChange(async (event, session) => {
      _listenerFired = true;
      _currentUser = session?.user || null;
      _renderAuthUI(_currentUser);

      if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') {
        // Ambos eventos pueden llegar al inicializar. _loginSyncDone garantiza
        // que aunque los dos disparen casi simultáneamente (comportamiento normal
        // de Supabase v2 en redirect OAuth), el modal solo aparece una vez.
        if (_currentUser) {
          await _loginSync();
        } else {
          // Sesión nula en INITIAL_SESSION = usuario no estaba logueado.
          // Renderizar en estado deslogueado ya fue hecho en _renderAuthUI arriba.
          _setSyncIndicator('idle');
        }
      } else if (event === 'SIGNED_OUT') {
        _loginSyncDone = false;
        _setSyncIndicator('idle');
      }
      // TOKEN_REFRESHED y USER_UPDATED: ignorados intencionalmente.
    });

    // ── Fallback de UI: solo para mostrar estado inicial mientras llega el evento
    //
    //  onAuthStateChange en Supabase v2 dispara INITIAL_SESSION de forma
    //  asíncrona pero casi inmediata (< 50 ms en condiciones normales).
    //  Este fallback solo entra si el evento tarda más de INIT_TIMEOUT_MS,
    //  lo que indicaría un problema de red. En ese caso mostramos la UI
    //  en el estado que podamos determinar localmente, sin bloquear la app.
    //  _loginSync() NO se llama desde acá: se llamará cuando llegue el evento.
    // ─────────────────────────────────────────────────────────────────────────
    const INIT_TIMEOUT_MS = 1500;
    await Promise.race([
      // Esperar a que el listener de arriba haya seteado _currentUser
      new Promise(resolve => {
        const check = setInterval(() => {
          if (_listenerFired) {
            clearInterval(check);
            resolve();
          }
        }, 30);
      }),
      // Timeout de seguridad
      new Promise(resolve => setTimeout(resolve, INIT_TIMEOUT_MS)),
    ]);

    // Si después del timeout el listener todavía no corrió (red muy lenta),
    // hacer getSession() solo para renderizar la UI sin bloquear.
    if (!_listenerFired) {
      const { data: { session } } = await _sb.auth.getSession();
      const fallbackUser = session?.user || null;
      if (fallbackUser && !_currentUser) {
        // El listener aún no llegó pero tenemos sesión local válida:
        // actualizar UI para que no se vea deslogueado. El sync llegará
        // cuando onAuthStateChange finalmente dispare.
        _currentUser = fallbackUser;
        _renderAuthUI(_currentUser);
        _setSyncIndicator('syncing'); // Indicar que sync está pendiente
      }
    }
  })();

  // ─────────────────────────────────────────
  //  API PÚBLICA
  // ─────────────────────────────────────────
  window.Sync = {
    notifyChange: notifyChange,
    authToggle:   authToggle,
    recoverDraft: recoverDraft,
  };

})();