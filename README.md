# Chocolate Business Manager · Dhaline

ERP web para el emprendimiento de chocotejas Dhaline: compras, inventario (promedio ponderado), producción con control de calidad,
presentaciones y cajas, ventas, finanzas (partida doble), rentabilidad, punto de equilibrio, reportes Excel/PDF y registro rápido en español.

## Instalar y usar

Requisitos: Node.js 22.13 o superior.

```bash
npm install        # instala ExcelJS y Chart.js (se copia a public/vendor)
npm start          # http://127.0.0.1:3000
npm test           # escenarios completos de prueba
```

Variables opcionales: `PORT` (3000), `HOST` (127.0.0.1; use `0.0.0.0` para abrirla desde el celular en la misma red WiFi),
`CBM_DATA_DIR` (carpeta de datos, por defecto `./data`).

La primera vez se crea la cuenta administradora. Los datos se guardan en `data/chocolate.db` (SQLite) y se respaldan
automáticamente en `data/backups/` cada día al iniciar. Descargue respaldos desde Configuración → Datos y guárdelos fuera del equipo.

## Primeros pasos recomendados

1. **Configuración → Datos → Cargar datos de demostración** para ver todo funcionando (lote de 30 con merma, cajas, ventas, cobros).
2. Revise los cálculos en Dashboard, Producción, Rentabilidad y Reportes.
3. **Configuración → Datos → Eliminar demo e iniciar operaciones reales** (crea un respaldo antes).
4. Registre a las socias y sus aportes (Finanzas → Aporte / retiro), por ejemplo la inversión ya realizada.
5. Cargue lo que ya tiene: **Inventario → Inventario inicial** (empaques, acetato, pirulinas, envolturas donadas con valor 0) y
   **Productos terminados → Saldo inicial** (cajas de 5, sueltas, cuadrados, defectuosas).
6. Desde ahí, use Compras, Producción, Presentaciones y Ventas — o el **Registro rápido**.

Ya vienen cargados (editables): costos históricos de manjar, cobertura, pecanas, almendras, pasas y chinchín; moldes como activos;
productos chinchín, pasas, pecanas y cuadrado (suelta S/ 2, defectuosa S/ 1); cajas de 4 (S/ 10), 5 (S/ 11, tentativo), 6 (S/ 12) y premium (S/ 15)
con una estructura de empaque propuesta para revisar.

Detalle técnico, tablas, fórmulas y reglas: [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md).
