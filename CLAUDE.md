# CLAUDE.md — Guía de arquitectura de Kompakt

Reglas obligatorias para cualquier código escrito en este proyecto.
Leer este archivo antes de tocar cualquier módulo.

---

## Estructura de archivos

```
js/
├── main.js            ← punto de entrada único
├── state.js           ← estado local y mutaciones
├── calculations.js    ← cálculos financieros puros
├── formatters.js      ← formato de datos puro
└── ui/
    ├── render.js      ← DOM output
    ├── modals.js      ← coordinación de modales
    ├── events.js      ← event delegation
    └── dragdrop.js    ← drag & drop
```

---

## Responsabilidad única por módulo

| Módulo | Hace | No hace |
|---|---|---|
| `state.js` | leer/escribir localStorage, mutar `S`, disparar `state:changed` | tocar DOM, saber que Supabase existe |
| `calculations.js` | recibir datos → devolver números | leer estado global, tocar DOM |
| `formatters.js` | recibir valores → devolver strings | leer estado global, tocar DOM |
| `render.js` | leer estado → escribir DOM | mutar estado, registrar listeners |
| `modals.js` | leer formularios → llamar mutaciones → llamar renders | tener lógica de negocio propia |
| `events.js` | instalar delegation, despachar acciones | mutar estado directamente |
| `dragdrop.js` | gestionar drag, llamar `reorderExpenses` | importar de `render.js` |
| `main.js` | arrancar app, registrar listeners estáticos, puentes con Sync | tocar DOM directamente, lógica de negocio |

---

## Reglas de estado

- `S` solo se muta desde funciones exportadas de `state.js`. Nunca `getState().months.push(...)` desde afuera.
- Toda mutación termina llamando `save()`. Nunca llamar `localStorage.setItem` desde otro módulo.
- `save()` dispara `state:changed`. Sync escucha ese evento. `state.js` no sabe que Sync existe.
- Las funciones de `state.js` son atómicas: reciben datos puros, mutan, persisten. No leen el DOM.

---

## Reglas de UI

### Event delegation — siempre sobre contenedores estables

```js
// ✅ correcto: listener en el contenedor, lee data attributes
container.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el || !container.contains(el)) return;
  handlers[el.dataset.action]?.(el);
});

// ❌ incorrecto: listener directo en elemento generado dinámicamente
row.addEventListener('click', () => delExp(id));
```

### HTML generado — solo datos, sin lógica

```js
// ✅ correcto
`<button data-action="delete-expense" data-id="${e.id}">✕</button>`

// ❌ incorrecto
`<button onclick="delExp('${e.id}')">✕</button>`
```

### Atributos de evento en HTML dinámico

- `data-action="..."` → responde a `click`
- `data-change="..."` → responde a `change` (checkboxes, selects, date inputs)
- `data-input="..."` → responde a `input` (campos de texto, números)
- `data-id` → id del gasto; `data-partial-id` → id del pago parcial

### Sub-renders granulares

Llamar el render mínimo necesario, no `render()` completo salvo que cambie la estructura:

```js
// cambió un número → solo métricas
refreshCalcs();

// cambió la lista de pagos → solo esa lista + métricas
renderPayments(getM()); refreshCalcs();

// cambió la estructura del mes (nuevo gasto, nuevo mes, import) → render completo
render();
```

---

## Reglas de red y eventos del sistema

- `state:changed` → lo dispara `save()`. Lo escucha `main.js` para notificar a Sync. Nadie más.
- `ui:rerender` → lo dispara `dragdrop.js` después de un reorder. Lo escucha `main.js` para llamar `render()`. Se usa solo cuando una mutación no tiene wrapper explícito de render.
- `window.load` y `window.render` se exponen únicamente para compatibilidad con `sync.js` (`_reloadAppState`). No agregar más funciones a `window`.
- `sync.js` no se modifica. El contrato con él es: escucha `state:changed` y puede llamar `window.load()` + `window.render()`.

---

## Reglas de funciones puras

`calculations.js` y `formatters.js` son completamente puros:
- reciben todos sus inputs como parámetros
- no leen de `state.js`, no tocan el DOM, no tienen side effects
- si necesitás un valor del estado en un cálculo, pasalo como parámetro desde quien llama

---

## Qué nunca hacer

- **No** registrar listeners dentro de funciones de render (se apilan en cada render).
- **No** llamar `render()` desde `state.js` ni desde `calculations.js`.
- **No** leer el DOM desde `state.js` ni desde `calculations.js`.
- **No** agregar `onclick/onchange/oninput` como atributos HTML en strings generados.
- **No** agregar entradas al bloque `window.xxx` de `main.js`. Si algo nuevo necesita ser global, revisá el diseño.
- **No** crear dependencias circulares. En particular: `dragdrop.js` no importa de `render.js`.

---

## Agregar funcionalidad nueva — checklist

1. ¿La mutación de datos va en `state.js`? → sí, siempre.
2. ¿El cálculo es puro? → va en `calculations.js` o `formatters.js`.
3. ¿La acción viene de HTML dinámico? → agregar `data-action` en `render.js` y el handler en `events.js`.
4. ¿La acción viene de HTML estático? → agregar `addEventListener` en `main.js`.
5. ¿Abre un modal o coordina UI compleja? → va en `modals.js`.
6. ¿Qué sub-render necesita? → el mínimo. Solo `render()` completo si es estructural.
