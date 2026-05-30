// ═══════════════════════════════════════════════════════════
//  SYNC.JS — Estrategia Offline-First con Supabase
//
//  Este módulo se encarga exclusivamente de la sincronización
//  en segundo plano. No modifica ni reemplaza la lógica de
//  script.js: solo se engancha a ella a través de window.Sync.
//
//  API pública:
//    window.Sync.notifyChange()  → llamar después de cada save()
//    window.Sync.authToggle()    → manejador del botón login/logout
// ═══════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ─────────────────────────────────────────
  //  CONFIGURACIÓN
  // ─────────────────────────────────────────
  const SUPABASE_URL     = 'https://znooeidrrqryyrytzwtz.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inpub29laWRycnFyeXlyeXR6d3R6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAwMDU5NzcsImV4cCI6MjA5NTU4MTk3N30.gswEBA5mII3b1ckPnrZSFFKJOf9Iw752DZkbdTte7SU';
  const LS_KEY           = 'gm_v1';
  const DEBOUNCE_MS      = 3000; // ms de espera antes de hacer push tras un cambio

  // ─────────────────────────────────────────
  //  INICIALIZACIÓN DEL CLIENTE SUPABASE
  // ─────────────────────────────────────────
  // El SDK de Supabase se carga vía CDN antes de este script.
  const _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // ─────────────────────────────────────────
  //  ESTADO INTERNO
  // ─────────────────────────────────────────
  let _currentUser    = null;
  let _debounceTimer  = null;
  let _isSyncing      = false;

  // ─────────────────────────────────────────
  //  HELPERS DE ESCAPE
  // ─────────────────────────────────────────
  function _esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ─────────────────────────────────────────
  //  UI: INDICADOR DE SINCRONIZACIÓN
  // ─────────────────────────────────────────
  function _setSyncIndicator(state) {
    const ind = document.getElementById('syncIndicator');
    if (!ind) return;

    const cfg = {
      syncing: { text: '↻ Sincronizando…', color: 'var(--muted)'  },
      synced:  { text: '✓ Sincronizado',   color: 'var(--green)'  },
      error:   { text: '⚠ Error de sync',  color: 'var(--red)'    },
      idle:    { text: '',                  color: 'var(--muted)'  },
    }[state] || { text: '', color: 'var(--muted)' };

    ind.textContent   = cfg.text;
    ind.style.color   = cfg.color;
    // El indicador se muestra siempre que haya sesión activa y un estado con texto.
    // Solo desaparece cuando el usuario cierra sesión (idle, sin _currentUser).
    // No hay auto-ocultado por tiempo: el estado queda fijo hasta el próximo cambio.
    ind.style.display = (_currentUser && cfg.text) ? 'inline' : 'none';
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
  }

  // ─────────────────────────────────────────
  //  AUTENTICACIÓN
  // ─────────────────────────────────────────
  async function _signInWithGoogle() {
    // Forzamos a que la URL de retorno sea siempre la dirección base limpia, 
    // ignorando cualquier token o basura que haya quedado escrita arriba.
    const cleanUrl = window.location.origin + window.location.pathname;
    
    const { error } = await _sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: cleanUrl },
    });
    
    if (error) {
      console.error('[sync] OAuth error:', error.message);
    }
  }

  function _signOut() {
    // ── Paso 1: Anular el estado interno inmediatamente ─────────────────────
    // Esto es lo primero y lo más importante: al poner _currentUser = null
    // cualquier _pushToCloud que esté en vuelo verá la guarda
    // `if (!_currentUser || _isSyncing)` y abortará sin llegar al indicador.
    _currentUser = null;
    clearTimeout(_debounceTimer);   // Cancelar push diferido pendiente
    _isSyncing   = false;           // Liberar el mutex por si quedó trabado
    _setSyncIndicator('idle');      // Limpiar el indicador de UI al instante

    // ── Paso 2: Eliminar ÚNICAMENTE el token de sesión de Supabase ──────────
    // No tocamos LS_KEY ('gm_v1'): los datos de la app se conservan offline.
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('sb-') && key.endsWith('-auth-token')) {
        localStorage.removeItem(key);
      }
    }

    // ── Paso 3: Pedirle a Supabase que invalide la sesión en el servidor ─────
    // Fire-and-forget: sin await, sin bloquear. Si tarda o falla, no importa;
    // nosotros ya limpiamos el token local en el paso anterior.
    _sb.auth.signOut().catch(() => {});

    // ── Paso 4: Recarga garantizada a los 500 ms ─────────────────────────────
    // Limpia la RAM, resetea todos los módulos y deja la app en estado fresco.
    // La página va a cargar sin sesión (token eliminado) y sin bloqueos.
    setTimeout(() => window.location.reload(), 500);
  }

  // Manejador público del botón → toggle entre login y logout
  function authToggle() {
    const btn = document.getElementById('authBtn');

    // Deshabilitar el botón de inmediato para prevenir doble clic.
    // En logout: la página se recarga en 500 ms de todas formas.
    // En login: se re-habilita solo si el redirect falla por algún motivo.
    if (btn) btn.disabled = true;

    if (_currentUser) {
      _signOut(); // Sincrónico + reload: el botón nunca vuelve a habilitarse
    } else {
      _signInWithGoogle().finally(() => {
        // Re-habilitar solo en caso de error (redirect exitoso ya cambia la página)
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
        .maybeSingle(); // maybeSingle devuelve null si no hay fila, sin tirar error

      if (error) {
        console.error('[sync] Pull error:', error.message);
        return null;
      }
      return data || null; // { data: {...}, updated_at: "..." } | null
    } catch (e) {
      console.error('[sync] Pull exception:', e);
      return null;
    }
  }

  // ─────────────────────────────────────────
  //  CLOUD: ESCRIBIR EN SUPABASE
  // ─────────────────────────────────────────
  // _pushToCloud es ahora una función de red pura.
  // NO gestiona _isSyncing: esa responsabilidad recae en _doSync y notifyChange,
  // que son quienes conocen el contexto de cada llamada. Esto elimina la colisión
  // de mutex que causaba el indicador congelado.
  // Incluye un timeout de 20 s para evitar el bloqueo por red colgada.
  async function _pushToCloud(payload) {
    if (!_currentUser) return false;

    const PUSH_TIMEOUT_MS = 20000;

    // Promise.race: si la red tarda más de 20 s, el timeout rechaza primero
    // y el catch actualiza el indicador a error, liberando el mutex en el caller.
    const upsertPromise = _sb
      .from('finanzas')
      .upsert(
        {
          user_id:    _currentUser.id,
          data:       payload,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' }
      );

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout de sincronización (20 s)')), PUSH_TIMEOUT_MS)
    );

    try {
      const { error } = await Promise.race([upsertPromise, timeoutPromise]);

      if (error) {
        console.error('[sync] Push error:', error.message);
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
  //  MERGE: FUSIÓN INTELIGENTE DE ESTADOS
  //
  //  Estrategia:
  //  - Si solo hay datos en un lado → ese lado gana.
  //  - Si ambos tienen _syncedAt → el más nuevo gana como base;
  //    los meses exclusivos del perdedor se agregan al final.
  //  - Si ninguno tiene _syncedAt → se combinan los meses de ambos
  //    usando el ID como clave de deduplicación.
  // ─────────────────────────────────────────
  function _mergeStates(local, cloud) {
    if (!cloud) return local;
    if (!local || !local.months || local.months.length === 0) return cloud;

    const localTs = local._syncedAt ? new Date(local._syncedAt).getTime() : 0;
    const cloudTs = cloud._syncedAt ? new Date(cloud._syncedAt).getTime() : 0;

    let base, other;
    if (cloudTs > localTs) {
      base  = cloud;
      other = local;
    } else {
      base  = local;
      other = cloud;
    }

    // Agregar al base los meses que solo existen en other (por ID)
    const baseIds        = new Set(base.months.map(m => m.id));
    const exclusiveOther = (other.months || []).filter(m => !baseIds.has(m.id));

    return {
      ...base,
      months: [...base.months, ...exclusiveOther],
    };
  }

  // ─────────────────────────────────────────
  //  SINCRONIZACIÓN PRINCIPAL
  //
  //  Lógica completa de decisión push/pull/merge.
  // ─────────────────────────────────────────
  async function _doSync() {
    // Guarda de sesión y de concurrencia: si ya hay un sync activo, no apilamos otro.
    // En JS single-thread, el check + set es atómico hasta el primer await, así que
    // no hay ventana de race condition entre la verificación y la asignación.
    if (!_currentUser || _isSyncing) return;
    _isSyncing = true;

    try {
      const localRaw  = localStorage.getItem(LS_KEY);
      const local     = localRaw ? _safeParse(localRaw) : null;
      const cloudRow  = await _pullFromCloud();
      const cloudData = cloudRow?.data || null;

      // Caso 1: nada en ningún lado
      if (!local && !cloudData) {
        _setSyncIndicator('synced');
        return;
      }

      // Caso 2: sin datos en la nube → subir todo lo local (primera sincronización)
      if (!cloudData) {
        const toUpload = { ...(local || {}), _syncedAt: new Date().toISOString() };
        localStorage.setItem(LS_KEY, JSON.stringify(toUpload));
        _setSyncIndicator('syncing');
        await _pushToCloud(toUpload);
        return;
      }

      // Caso 3: sin datos locales → bajar de la nube
      if (!local) {
        localStorage.setItem(LS_KEY, JSON.stringify(cloudData));
        _reloadAppState();
        _setSyncIndicator('synced');
        return;
      }

      // Caso 4: ambos tienen datos → comparar timestamps con precisión estricta
      const localTs = local._syncedAt ? new Date(local._syncedAt).getTime() : 0;
      const cloudTs = cloudData._syncedAt ? new Date(cloudData._syncedAt).getTime() : 0;

      if (cloudTs > localTs) {
        // La nube es más nueva → pull + merge de meses locales exclusivos
        const merged = _mergeStates(local, cloudData);
        merged._syncedAt = cloudData._syncedAt;
        localStorage.setItem(LS_KEY, JSON.stringify(merged));
        _reloadAppState();
        _setSyncIndicator('synced');

      } else if (localTs > cloudTs) {
        // Lo local es más nuevo → push
        // (cubre el primer login con datos históricos locales sin _syncedAt)
        const toUpload = { ...local, _syncedAt: local._syncedAt || new Date().toISOString() };
        _setSyncIndicator('syncing');
        await _pushToCloud(toUpload);

      } else {
        // ── CORRECCIÓN CLAVE ──────────────────────────────────────────────────
        // Timestamps iguales = ya estamos sincronizados. No hay nada que subir.
        // El else original trataba este caso como "necesita push", disparando un
        // upsert redundante que colisionaba con el mutex de notifyChange y dejaba
        // el indicador congelado en 'syncing'. Ahora simplemente confirmamos sync.
        _setSyncIndicator('synced');
      }

    } finally {
      // El mutex se libera siempre, pase lo que pase (error, timeout, éxito).
      _isSyncing = false;
    }
  }

  // ─────────────────────────────────────────
  //  HELPERS INTERNOS
  // ─────────────────────────────────────────
  function _safeParse(str) {
    try { return JSON.parse(str); } catch { return null; }
  }

  // Recarga el estado de la app invocando las funciones globales de script.js
  function _reloadAppState() {
    if (typeof load === 'function' && typeof render === 'function') {
      load();
      render();
    }
  }

  // ─────────────────────────────────────────
  //  NOTIFICACIÓN CON DEBOUNCE
  //
  //  Llamada desde script.js después de cada save().
  //  Agrupa múltiples cambios rápidos en un solo push.
  // ─────────────────────────────────────────
  function notifyChange() {
    if (!_currentUser) return;

    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(async () => {
      // Chequeo + set de mutex son sincrónicos hasta el primer await:
      // ningún otro handler puede colarse entre estas dos líneas.
      if (_isSyncing) return; // Un _doSync está en curso; los datos ya están frescos
      _isSyncing = true;

      try {
        const localRaw = localStorage.getItem(LS_KEY);
        if (!localRaw) return;

        const local = _safeParse(localRaw);
        if (!local) return;

        // Sellar el timestamp y guardar antes de subir
        local._syncedAt = new Date().toISOString();
        localStorage.setItem(LS_KEY, JSON.stringify(local));

        _setSyncIndicator('syncing');
        await _pushToCloud(local);
      } finally {
        // Liberar el mutex siempre, incluso si _pushToCloud falló o hizo timeout
        _isSyncing = false;
      }
    }, DEBOUNCE_MS);
  }

  // ─────────────────────────────────────────
  //  INICIALIZACIÓN DEL MÓDULO
  // ─────────────────────────────────────────
  (async function _init() {
    // 1. Escuchar cambios de sesión (login, logout, refresco de token)
    _sb.auth.onAuthStateChange(async (event, session) => {
      _currentUser = session?.user || null;
      _renderAuthUI(_currentUser);

      if (event === 'SIGNED_IN') {
        // Sincronizar al entrar: maneja tanto el primer login como los siguientes
        await _doSync();
      } else if (event === 'SIGNED_OUT') {
        _setSyncIndicator('idle');
      } else if (event === 'TOKEN_REFRESHED') {
        // Re-sincronizar silenciosamente al renovar el token
        await _doSync();
      }
    });

    // 2. Verificar sesión activa al cargar la página
    const { data: { session } } = await _sb.auth.getSession();
    _currentUser = session?.user || null;
    _renderAuthUI(_currentUser);

    if (_currentUser) {
      await _doSync();
    }
  })();

  // ─────────────────────────────────────────
  //  API PÚBLICA
  // ─────────────────────────────────────────
  window.Sync = {
    notifyChange: notifyChange,
    authToggle: authToggle,
    _doSync: _doSync
};

})();