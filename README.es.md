<div align="center">

<img src="docs/screenshots/mark.svg" alt="Ottr" width="140" />

# Ottr

### Un gestor personal de servidores con IA nativa

*Nade entre sus servidores.*

**Código abierto · Gratuito · macOS / Windows / Linux · Sus datos siguen siendo suyos**

[![GitHub](https://img.shields.io/badge/GitHub-huluohu%2FOttr-0F172A)](https://github.com/huluohu/Ottr)
[![Plataforma](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-14B8A6)](#-download--install)
[![Licencia](https://img.shields.io/badge/license-MIT-5EEAD4)](#-license--author)

**Idiomas:** [English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Italiano](README.it.md)

</div>

---

**Ottr** es un cliente SSH con IA, ligero y de código abierto: unos 8 MB instalados (84 MB en el AppImage), alrededor de 100 MB de memoria residente, sin servicios en segundo plano y sin agentes que instalar. Convierte «conectarse a un servidor y escribir comandos» en «su terminal entiende la IA»: diagnostica por usted los comandos fallidos, genera comandos a partir de lenguaje natural y le permite buscar en el historial desde cualquier lugar.

La regla innegociable que nunca incumple: **usted aporta su propia clave de IA (BYOK)**. Las solicitudes van directamente desde su equipo al endpoint del modelo que haya elegido: no hay ningún servidor de Ottr por medio. Los secretos se cifran en reposo en su propio equipo; los metadatos de los hosts y el historial de comandos se guardan en un archivo SQLite local. El límite exacto de datos de las solicitudes de IA y de la sincronización opcional se describe en [Privacidad e IA](#-privacy--ai-data-boundaries).

![Pantalla de bienvenida: saludo según la hora del día, acciones rápidas y la barra de iconos](docs/screenshots/home-welcome.png)

## ✨ Qué hace

### Terminal y sesiones

- **Pestañas y paneles divididos** (en paralelo o apilados), renderizado acelerado por GPU, búsqueda, detección de URLs y compatibilidad completa con secuencias de escape
- **Codificación que se adapta**: UTF-8 / GBK / GB18030 se detectan automáticamente y se pueden cambiar a mano: imprescindible para servidores Windows en chino
- **Conexiones autorreparables**: reconexión automática con espera progresiva, detección de enlaces muertos mediante keepalive, un indicador de estado de la conexión y pestañas restauradas tras un reinicio
- **Grabación de sesiones** en formato [asciinema v2](https://docs.asciinema.org/manual/asciinema-v2/), con un reproductor de línea de tiempo dentro de la aplicación (desplazamiento, aceleración) y exportación como **texto redactado** que puede compartir

### Hosts y credenciales

- Grupos, etiquetas, búsqueda y **conexión rápida con búsqueda difusa mediante ⌘K**; la importación y la exportación admiten `~/.ssh/config`, Tabby (JSON/YAML), sesiones de Xshell y CSV: las exportaciones solo contienen metadatos de los hosts, nunca secretos
- Caja de credenciales: contraseñas, claves SSH (ed25519/ecdsa/rsa: genere, importe y despliegue la clave pública) y segundo factor TOTP, vinculados a los hosts y **con nombre propio**, de modo que una credencial puede servir a varios hosts
- **Cadenas de hosts de salto** dispuestas visualmente; **reenvío de puertos** local, dinámico con SOCKS y remoto, restablecido automáticamente tras una caída
- known_hosts con **confianza en el primer uso y auditorías periódicas de huellas**, para detectar ataques de intermediario (man-in-the-middle)

![Tema oscuro: barra de iconos, panel de hosts, islas de pestañas flotantes e indicadores de estado de conexión](docs/screenshots/main-dark.png)

### IA que respeta sus datos

- **Diagnóstico ante fallos**: un código de salida distinto de cero muestra la causa probable y una corrección sugerida; nada se ejecuta sin su confirmación y los comandos riesgosos se marcan en rojo
- **⌘J para generar un comando**: describa en chino o en inglés lo que desea y obtendrá una única línea de vuelta, anclada al directorio actual
- **Seleccionar para explicar**: haga clic derecho sobre cualquier texto seleccionado para explicarlo, traducirlo o repararlo; las sesiones pueden terminar con un resumen generado automáticamente, que se puede buscar con ⌘R
- **BYOK con múltiples proveedores**: endpoints compatibles con OpenAI (**OpenAI / DeepSeek / Zhipu GLM / cualquier endpoint que usted aloje**), Anthropic Claude y Ollama local: los preajustes completan el endpoint por usted y las claves se cifran en su equipo
- **Redacción por reglas**: las coincidencias en diagnósticos, explicaciones y resúmenes se sustituyen por marcadores de posición. No se puede garantizar que se detecten todos los secretos; la entrada de comandos en lenguaje natural y el contexto del directorio actual **no** se redactan. Ottr también incluye un servidor MCP (en las tres plataformas) con el que cualquier cliente MCP de stdio —Claude Desktop, Cursor, …— puede comunicarse, con autorización por host y aprobación en cada llamada

### Supervisión, alertas y operaciones

- **Supervisión sin agentes**: gráficos en vivo de CPU / memoria / disco / carga / red y un explorador de procesos, con una vista general de varios hosts
- **Reglas de alerta** (disco, CPU, proceso, palabra clave en el log) enrutadas por **12 canales de notificación**: WeCom, DingTalk, Feishu, Telegram, Slack, Discord, correo SMTP y muchos más, con limitación de tasa, reintentos y un registro de entregas durable
- **Tareas programadas** ejecutadas por un planificador nativo (las ejecuciones perdidas se registran, no se pierden), además de **ejecución por lotes** sobre los hosts seleccionados con una biblioteca de fragmentos, control de concurrencia y control de tiempo de espera

### Archivos y sincronización

- **Explorador SFTP de dos paneles**: transferencia por arrastrar y soltar, fragmentos en paralelo, cargas reanudables; compatible con trzsz (trz/tsz); también FTP y FTPS
- **Edición remota** en su editor local con guardado atómico (un fallo nunca corrompe el archivo remoto) y detección de binarios para evitar ediciones accidentales
- **Sincronización multidispositivo** mediante un envoltorio cifrado de extremo a extremo (AES-256-GCM + PBKDF2) sobre uno de tres canales: **WebDAV, Git o una carpeta local** (WebDAV pasa por un proxy nativo directo a su propia unidad, sin restricciones de origen cruzado), con envío/recepción por categoría y una decisión manual para cada conflicto

### Seguridad que puede auditar

- Los secretos y las credenciales están protegidos con **AES-256-GCM** (no con cifrado de toda la base de datos). Hay dos modos: el **modo llavero** es el predeterminado (la clave maestra reside en el llavero de su sistema, así que la aplicación simplemente se abre) o el **modo con contraseña maestra** (derivación con Argon2id: sin la contraseña, los campos secretos no se pueden descifrar). Puede cambiar de modo en cualquier momento; cuando lo haga, los secretos se vuelven a cifrar
- Las copias sensibles se borran según una programación, y la pantalla de bloqueo ofrece un restablecimiento guiado de «olvidé mi contraseña» (con confirmación; las copias de seguridad en la nube no se tocan)
- Ottr no envía **ninguna telemetría**. Las funciones de IA y de sincronización sí envían los datos que necesitan: eso no significa que «ningún dato de host salga nunca de su equipo»

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/palette.png" alt="Paleta de comandos"></td>
    <td width="50%"><img src="docs/screenshots/cron.png" alt="Centro de tareas programadas"></td>
  </tr>
  <tr>
    <td width="50%">Paleta de comandos de ⌘K (búsqueda difusa)</td>
    <td width="50%">Centro de tareas programadas</td>
  </tr>
</table>

<details>
<summary>Más capturas de pantalla</summary>

![Vista general de varios hosts](docs/screenshots/overview.png)
![Administrador de credenciales](docs/screenshots/credentials.png)

</details>

## 📦 Descarga e instalación <a id="-download--install"></a>

Obtenga la compilación para su plataforma desde [**Releases**](https://github.com/huluohu/Ottr/releases):

| Plataforma | Formatos |
|---|---|
| macOS (Apple Silicon) | `.dmg` |
| macOS (Intel) | `.dmg` |
| Windows | instalador `.msi` / `.exe`, o **`_x64_portable.zip` (sin necesidad de instalar)** |
| Linux | `.deb` / `.rpm` / `.AppImage` |

En el primer inicio, Ottr le pregunta cómo quiere cifrar los campos secretos en este equipo (no toda la base de datos): **modo llavero** (sin contraseña que recordar) o **modo con contraseña maestra** (los campos secretos no se pueden descifrar sin ella).

**Compilación portátil para Windows**: descomprímala en cualquier carpeta y ejecute `Ottr.exe`: no se instala nada y su configuración y sus datos se guardan junto a la aplicación, en `Ottr/data/` (copie la carpeta para trasladar su configuración o bórrela para desinstalar; se requiere WebView2, aunque Win10/11 normalmente ya lo incluye). La compilación portátil no puede actualizarse por sí sola: descargue el nuevo zip y sobrescriba el anterior, conservando `data/` para no perder nada.

La compilación instalada ofrece **actualizaciones dentro de la aplicación** (Settings → About, solo paquetes firmados), y siempre puede volver a esta página para una descarga manual.

<details>
<summary><strong>🍎 ¿macOS dice que está «dañado» o no puede llegar a su LAN? Abra para ver la solución</strong></summary>

Todavía no se ha firmado Ottr con un Apple Developer ID, por lo que macOS lo trata con más rigor de lo habitual: **la descarga no está dañada**. Dos pasos y listo.

**1️⃣ «Ottr está dañado y no se puede abrir. Debería moverlo a la Papelera.»**

Abra Terminal y ejecute esto una vez; después abra Ottr con normalidad (repítalo tras cada actualización):

```bash
xattr -cr /Applications/Ottr.app
```

**2️⃣ «No route to host» al conectar con un equipo de su LAN**

Desde macOS 15, una aplicación debe tener concedido el acceso a «Red local» antes de poder alcanzar los dispositivos de su red. Si aparece el aviso, pulse **Allow**. Si nunca aparece y la conexión falla, elija una de estas opciones:

- **Inicie Ottr desde Terminal** (las aplicaciones iniciadas así no se ven afectadas):

  ```bash
  /Applications/Ottr.app/Contents/MacOS/ottr &
  ```

- **Autorice su rango de LAN una sola vez** (solicita una contraseña de administrador; sustituya `192.168.9.0/24` por su propio rango y reinicie):

  ```bash
  sudo defaults write com.apple.network.local-network AllowedWiFiLocalNetworkAddresses -array "192.168.9.0/24"
  sudo defaults write com.apple.network.local-network AllowedEthernetLocalNetworkAddresses -array "192.168.9.0/24"
  ```

  Para restablecer más adelante el valor predeterminado del sistema, ejecute estos comandos y reinicie una vez más:

  ```bash
  sudo defaults delete com.apple.network.local-network AllowedWiFiLocalNetworkAddresses
  sudo defaults delete com.apple.network.local-network AllowedEthernetLocalNetworkAddresses
  ```

Cuando Ottr se distribuya con una firma adecuada de Apple Developer ID, nada de esto será necesario.

</details>

## 🚀 Inicio rápido

1. **Añada un host**: «New host» en la barra lateral (pase el cursor por el encabezado de un grupo y pulse **＋** para añadirlo directamente a ese grupo) o «Import ssh config»; haga doble clic en la fila de un host para conectarse: la huella se muestra en el primer contacto y no se vuelve a pedir una vez que la ha aceptado
2. **Active la IA**: Settings → AI → añada un proveedor (elija un preajuste como Zhipu GLM, DeepSeek u Ollama y pegue su clave). A partir de ese momento, los comandos fallidos se diagnostican automáticamente y **⌘J** convierte una petición en lenguaje natural en un comando
3. **Configure las alertas**: Settings → Alerts → añada un canal de notificación (envíe un mensaje de prueba para verificarlo) → cree una regla como «root partition > 90%». La sección «notification types» de la misma página decide qué eventos le notifican
4. **Sincronice entre dispositivos**: instale Ottr en el segundo dispositivo, elija un canal en Settings → Sync (para WebDAV, introduzca la URL de su unidad), defina una frase de contraseña de sincronización y pulse **Sync now**
5. **Explore más**: **⌘R** busca en el historial, **⌘D** (Ctrl+⇧D en Windows/Linux) divide el panel, el menú «File» (macOS) importa y exporta hosts, y el menú «Tools» (macOS) o la paleta **⌘K** dan acceso al reenvío de puertos, a las cadenas de hosts de salto, a las tareas programadas, a la ejecución por lotes y al centro de notificaciones (los contadores de no leídos aparecen justo en la barra de iconos y en los menús)

## 🔐 Privacidad y límites de datos de la IA <a id="-privacy--ai-data-boundaries"></a>

- **Almacenamiento local**: las contraseñas SSH, las claves privadas, las frases de contraseña de las claves y las claves de API de IA se cifran campo a campo con AES-256-GCM. Las direcciones de los hosts, los nombres de usuario, las notas, el historial de comandos y los ajustes habituales permanecen en texto plano en un archivo SQLite local: bloquear la caja de credenciales o definir una contraseña maestra no los cifra. La sincronización usa su propio envoltorio cifrado y no cambia la forma en que se almacena la base de datos local.
- **Diagnósticos y explicaciones**: un diagnóstico envía el comando fallido y el final de la salida de la terminal (hasta 8 KB); una explicación envía el texto que ha seleccionado. Antes de enviarlos, unas reglas sustituyen las direcciones IP, las asignaciones de contraseña, las direcciones de correo electrónico y —si están activadas— los nombres de host y sus propios patrones personalizados. Los resúmenes aplican reglas similares a las secuencias de comandos. Las reglas pueden pasar por alto secretos que no se parezcan a los ejemplos, a los nombres internos o a los datos del negocio; «N elementos redactados» cuenta las coincidencias, no garantiza que esté todo cubierto. El panel puede seguir mostrando el texto original en local.
- **Generación de comandos a partir de lenguaje natural**: su petición y el directorio actual (OSC 7) se envían al endpoint del modelo que haya elegido como contexto, sin la redacción anterior. No escriba contraseñas, tokens ni nada que no desea que se envíe. Una conexión directa no impide que el proveedor reciba o conserve el contenido: eso depende del proveedor.
- **Ollama**: el endpoint preajustado es `http://localhost:11434/v1`. El procesamiento es local solo mientras el endpoint y la inferencia permanezcan en este equipo; en cuanto lo apunte a una dirección remota, a un proxy o a un modelo en la nube, ya no podemos garantizar que el contenido siga siendo local.
- **Inserción de comandos de IA**: solo se acepta texto de una sola línea sin saltos de línea ni caracteres de control, y no se añade ningún retorno de carro. El contenido de varias líneas se conserva tal cual y la inserción queda deshabilitada: revíselo y prepare usted mismo el comando; no se concatena ni se trunca nada a la primera línea. La clasificación de riesgo es un indicio, no una prueba de que un comando sea seguro. Confirme igualmente que la terminal está en el estado que espera antes de insertar y compruebe lo que ya esté escrito; las combinaciones de teclas personalizadas y los programas interactivos no quedan cubiertos por esta garantía.

## 📄 Licencia y autor <a id="-license--author"></a>

**Ottr** está desarrollado por [@huluohu](https://github.com/huluohu) y se publica bajo la licencia [MIT](LICENSE-MIT): las incidencias y las pull requests son bienvenidas. Repositorio: [github.com/huluohu/Ottr](https://github.com/huluohu/Ottr).

<div align="center">

*Nade entre sus servidores.* 🦦

</div>
