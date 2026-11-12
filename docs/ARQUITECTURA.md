# Chocolate Business Manager — Arquitectura

ERP para Dhaline (chocotejas artesanales, Lima). Conecta cinco procesos:
**compras → inventario → producción y calidad → ventas → contabilidad gerencial**.
Toda operación se registra una sola vez y desde ahí se derivan stock, costos, caja e indicadores.

## 1. Decisiones técnicas

| Tema | Decisión | Motivo |
|---|---|---|
| Servidor | Node.js ≥ 22.13, HTTP nativo, sin framework | Menos dependencias, fácil de instalar en una laptop |
| Base de datos | SQLite embebido (`node:sqlite`), modo WAL, claves foráneas | Persistente, transaccional, un solo archivo (`data/chocolate.db`) |
| Consistencia | Cada operación de negocio corre dentro de `db.tx()` (BEGIN IMMEDIATE / savepoints). Si algo falla, se revierte todo | No hay stock descontado sin asiento, ni asiento sin stock |
| Contabilidad | Partida doble: cada operación genera un asiento balanceado; si no cuadra, se aborta | Evita doble conteo y permite estados financieros exactos |
| Inventario de insumos | Costo promedio ponderado perpetuo, kárdex por insumo | Pedido explícito; adecuado para insumos fungibles |
| Producto terminado | Lotes con costo específico; salida FEFO (primero en vencer) | Trazabilidad por lote y costo histórico inmutable |
| Frontend | SPA en JavaScript (módulos ES) sin build; Chart.js local | Funciona sin internet; CSP estricta (`script-src 'self'`) |
| Seguridad | Usuarios con roles (admin/operador/lectura), contraseñas scrypt, sesión en cookie HttpOnly SameSite=Strict, solo JSON del mismo origen, límite de intentos, auditoría | |
| Exportación | Excel real (.xlsx, ExcelJS) y PDF vía vista de impresión del navegador | |
| Respaldo | Respaldo automático diario al iniciar + descarga manual + respaldo previo a reinicios | |

**Alcance honesto:** es una aplicación local (o de red local) de un solo servidor. Varios usuarios pueden usarla desde el navegador
con sus propias cuentas, pero el respaldo depende de que se descarguen copias fuera del equipo. Para uso en la nube habría que
desplegarla en un servidor con HTTPS (la cookie se marca `Secure` cuando llega `X-Forwarded-Proto: https`).

## 2. Módulos (carpeta `server/services`)

| Módulo | Responsabilidad |
|---|---|
| `ledger.js` | Plan de cuentas, asientos, reversiones, saldos |
| `inventory.js` | Insumos, entradas/salidas a promedio ponderado, consumo directo, conteo físico, saldos iniciales, kárdex |
| `purchases.js` | Compras (inventario / activo / gasto directo), anulación, pagos a proveedores |
| `production.js` | Productos y precios por calidad, fichas técnicas, lotes, asignación de costos, lotes de producto terminado, ajustes |
| `presentations.js` | Presentaciones (cajas), costo estimado, armado y desarmado |
| `sales.js` | Pedidos, despacho, cobros, devoluciones, cancelaciones |
| `finance.js` | Gastos, aportes/retiros, préstamos, transferencias, caja, CxC, CxP |
| `reports.js` | Estado de resultados, flujo de caja, balance, rentabilidad, punto de equilibrio, alertas, dashboard |
| `quick.js` | Registro rápido (lenguaje natural → borrador) |
| `seed.js` | Configuración inicial real y escenario DEMO |
| `../export.js` | Reportes tabulares → JSON / Excel / HTML imprimible |

## 3. Modelo de datos (principales tablas y relaciones)

```
accounts ─< journal_lines >─ journal_entries (ref_type, ref_id → operación de origen)
items ─< inventory_movements (kárdex)      items ─< item_prices (historial de precios)
suppliers ─< purchases ─< purchase_lines ─> items | assets
products ─< product_prices >─ quality_categories        price_history (productos y presentaciones)
products ─< recipes ─< recipe_lines ─> items
batches ─< batch_consumptions ─> items (y su movimiento de kárdex)
batches ─< batch_outputs ─> quality_categories
batches ─< fg_lots (producto + calidad + costo unitario + vencimiento) ─< fg_movements
presentations ─< presentation_components ─> products | items
assemblies ─< assembly_consumptions ─> fg_lots | items ;  assemblies ─ pack_lots (cajas armadas)
customers ─< sales ─< sale_lines ─< sale_allocations ─> fg_lots | pack_lots
                       sale_lines ─< sale_cost_details (producto, calidad, lote, empaque: trazabilidad y rentabilidad)
sales ─< sale_payments ;  sales ─< sale_returns
expenses, supplier_payments, partners ─< capital_moves, loans ─< loan_payments, transfers
item_consumptions, inventory_counts, budgets, fixed_costs, campaigns, users, sessions, audit_log, settings
```

Todas las tablas operativas tienen `status` (`activo/anulado`) en lugar de borrado. Los maestros de demostración tienen `is_demo=1`.

## 4. Plan de cuentas

| Código | Cuenta | Código | Cuenta |
|---|---|---|---|
| 1101–1105 | Efectivo, Yape, Plin, Banco/Transferencias, Otros | 3101 | Aportes de socias |
| 1201 | Cuentas por cobrar (neto de adelantos) | 3102 | Retiros de socias |
| 1301 | Inventario materia prima | 3103 | Saldos de apertura |
| 1302 | Inventario empaques | 4101 / 4102 / 4103 | Ventas / Delivery cobrado / Otros ingresos |
| 1303 | Inventario suministros | 4191 / 4192 | Descuentos / Devoluciones |
| 1304 | Inventario productos terminados | 5101 | Costo de ventas |
| 1305 | Inventario cajas armadas | 5103 | Mermas y ajustes de inventario |
| 1401 | Herramientas y activos | 6101–6107 | Gastos operativos, administrativos, marketing, delivery, comisiones, otros, mano de obra pagada |
| 2101 | Cuentas por pagar proveedores | 6109 | Gastos financieros |
| 2201 | Préstamos por pagar | 6190 | MO y CIF imputados aplicados a producción (contra-gasto) |

## 5. Flujos y asientos

| Operación | Asiento | Inventario |
|---|---|---|
| Compra de insumo | D 1301/1302/1303 · H caja o 2101 | + unidades, recalcula promedio |
| Compra de herramienta | D 1401 · H caja o 2101 | — (activo) |
| Compra de gasto directo | D 61xx · H caja o 2101 | — |
| Lote de producción | D 1304 (unidades comercializables) · H 1301/1302/1303 (insumos a promedio) · H 6190 (MO + CIF imputados) | − insumos; + lotes de producto terminado |
| Lote sin unidades comercializables | D 5103 por el total | − insumos |
| Armado de cajas | D 1305 · H 1304 (chocotejas) · H 1302 (empaques) | − chocotejas (FEFO), − empaques; + cajas armadas |
| Despacho de pedido (estado Listo/Entregado) | D 1201 total + D 4191 descuentos · H 4101 ventas brutas + H 4102 delivery · D 5101 · H 1304/1305 | − lotes; si faltan cajas armadas, se arman en el momento |
| Cobro | D caja (neto de comisión) + D 6105 comisión · H 1201 | — |
| Delivery pagado por el negocio | Gasto 6104 al entregar | — |
| Devolución | D 4192 · H 1201; reingreso: D 1304/1305 · H 5101; sin reingreso: D 5103 · H 5101 | reingresa al lote de origen |
| Consumo directo | D gasto o 5103 · H inventario | − insumo |
| Conteo físico | Diferencia contra 5103 | ajuste al promedio |
| Aporte / retiro | D caja · H 3101 / D 3102 · H caja | — |
| Préstamo / pago | D caja · H 2201 / D 2201 + D 6109 · H caja | — |
| Anulación | Asiento inverso con la fecha original + auditoría | movimientos inversos al costo original |

**No duplicación:** la compra de insumos nunca es gasto; solo lo consumido llega al costo (vía lote → 1304 → 5101 al vender).
Las 15 cajas usadas de 100 compradas a S/ 80 cuestan S/ 12; las 85 restantes siguen valiendo S/ 68 en inventario.

## 6. Fórmulas

**Promedio ponderado (por insumo)**
- Entrada: `saldo_valor += costo_total`; `saldo_cant += cantidad` → `costo_promedio = saldo_valor / saldo_cant`
- Salida: `costo = cantidad × costo_promedio` (si el saldo queda en cero, se retira el valor exacto restante)

**Costo de lote**
- `materiales = Σ cantidad_i × promedio_i` (al momento del consumo)
- `costo_total = materiales + mano_de_obra + costos_indirectos`
- `costo por unidad producida = costo_total / producidas`
- `merma % = no_comercializables / producidas`; `rendimiento % = comercializables / producidas`
- `valor de la merma = no_comercializables × costo por unidad producida` (informativo; queda absorbido)
- `costo teórico = Σ receta_i × (producidas / rendimiento_receta) × costo_vigente_i + MO + CIF escalados`; `variación = real − teórico`

**Asignación del costo entre calidades** (configurable; se guarda el método usado en cada lote)
- *Igual:* `costo_u = costo_total / comercializables` (originales y de segunda cuestan lo mismo)
- *Factor:* `costo_u(q) = costo_total × factor(q) / Σ (cant(q) × factor(q))` (ej. segunda = 0.6)
- *Valor de venta (VNR):* igual que factor usando `precio(producto, calidad)` como peso
- Las no comercializables no reciben costo propio: su costo se reparte entre las vendibles (la merma encarece el lote).

Ejemplo verificado en pruebas: 30 chocotejas, costo S/ 13.24, 24 A / 4 B / 2 C → método igual: S/ 0.4729 por unidad comercializable.

**Ventas y resultados**
- `ventas brutas = Σ cantidad × precio + delivery cobrado`; `ventas netas = brutas − descuentos − devoluciones`
- `utilidad bruta = ventas netas − costo de ventas`
- `utilidad operativa = utilidad bruta − mermas − gastos operativos + MO/CIF imputados aplicados`
- `utilidad neta = utilidad operativa − gastos financieros + otros ingresos`; `margen neto = utilidad neta / ventas netas`

**Rentabilidad por dimensión** (producto, presentación, calidad, lote, campaña, canal, cliente): por cada línea vendida se usa su
ingreso neto (descuento del pedido prorrateado y devoluciones restadas) y su costo real (`sale_cost_details`). En cajas, el ingreso se
reparte entre su contenido en proporción al costo, y el empaque se carga a las chocotejas que contiene.

**Productos de segunda:** `recuperación = ingreso / costo`; `margen sacrificado = unidades × precio_promedio_original − ingreso`.

**Punto de equilibrio multiproducto (mezcla de ventas)**
- `mezcla_i = unidades_i / Σ unidades` (ventas reales de 90 días; sin ventas: catálogo con mezcla uniforme)
- `MC_i = precio_i − costo_variable_i` (costo real promedio + comisión de cobro %)
- `MC ponderado = Σ mezcla_i × MC_i`
- `unidades de equilibrio = costos fijos / MC ponderado`; por presentación `= total × mezcla_i`
- `ventas de equilibrio = Σ unidades_i × precio_i`
- `avance = MC acumulado del mes / costos fijos`
- Escenarios (conservador / esperado / optimista): volumen × 0.7 / 1 / 1.3 y costo × 1.05 / 1 / 0.97 → `utilidad = Σ q·(p − v) − fijos`

## 7. Reglas de negocio implementadas

1. Compras ≠ gastos: entran al inventario o a activos. 2. Ingresos ≠ utilidad (estado de resultados separado del flujo de caja).
3. Sin doble costo: un solo asiento por operación; validación de cuadre. 4. Ningún descuento de stock sin movimiento (kárdex / `fg_movements`).
5. Stock negativo bloqueado; solo una administradora puede autorizarlo explícitamente en el despacho, y queda auditado.
6. Calidades con stock, precio y margen propios. 7. Mermas registradas y absorbidas en el costo real.
8. Empaques forman parte del costo al armar/vender cajas. 9. Trazabilidad por lote hasta la venta.
10. Cambiar precios no altera costos históricos (historial de precios). 11. Lotes antiguos conservan su costo; las fichas usan precios vigentes.
12. Contable ≠ caja: estado de resultados vs flujo de caja. 13. Correcciones por anulación con asiento inverso; no hay borrado silencioso.

## 8. Casos especiales contemplados

- Lote sin unidades vendibles → todo el costo a mermas.
- Compra anulada cuyo insumo ya se usó → bloqueada (usar ajuste).
- Lote anulado con unidades vendidas o armadas → bloqueado.
- Pedido cancelado después de despachado → stock vuelve a los mismos lotes; cobros quedan como saldo a favor (reembolso con monto negativo).
- Pedido entregado → no se cancela; se registra devolución (con o sin reingreso).
- Cobro antes del despacho → saldo a favor/adelanto en cuentas por cobrar.
- Caja vendida sin cajas armadas → se arma automáticamente al despachar.
- Caja surtida → toma sabores FEFO o la composición indicada.
- Producto de segunda que se rompe en stock → reclasificación a "no comercializable" (merma) o a otra calidad, conservando costo.
- Insumos donados → saldo inicial con valor 0.
- Productos/insumos que ya existían antes del sistema → saldos de apertura (no son compras del mes).
- Precio de compra ambiguo en el registro rápido ("2 kg a S/ 32") → se compara con el precio de referencia y se avisa la interpretación.

## 9. Registro rápido

`quick.parse(db, texto)` usa reglas locales (verbos, números en palabras, unidades, importes `S/`, coincidencia con nombres y alias del
catálogo). Devuelve tipo, fecha, líneas, preguntas y advertencias. **No registra nada**: abre el formulario del módulo con los datos
detectados para que la usuaria complete y confirme. Si falta un dato (cantidad comprada, gramos de "20 pecanas", sabor vendido,
medio de pago) se pregunta. La interfaz `parse(db, text)` permite agregar en el futuro un adaptador de IA opcional con la misma salida.

## 10. Verificación

`npm test` ejecuta escenarios completos (compra parcial, promedio ponderado, stock negativo, lote con merma, métodos de
asignación, venta de originales y de segunda, caja con empaques, cancelación, devolución, anulación, finanzas, punto de equilibrio,
registro rápido y datos demo). Configuración → General muestra un control de integridad: libro cuadrado, kárdex = cuentas de
inventario, lotes = cuenta de producto terminado y balance (activo = pasivo + patrimonio).
