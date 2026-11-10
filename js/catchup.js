// Catch-up (TV a la carta / diferido): URL del archivo de un programa ya emitido.
//
// Atributos M3U (en #EXTINF o, para toda la lista, en #EXTM3U), como Kodi y TiviMate:
//   catchup="default|append|shift|flussonic|xc"  catchup-source="…"  catchup-days="7"
//   (también timeshift="7" y tvg-rec="7" como días de archivo).
//
// Marcadores de catchup-source (Kodi PVR IPTV Simple y TiviMate):
//   {utc} {start} ${start}         inicio (segundos Unix)
//   {utcend} {end} ${end}          fin
//   {lutc} {timestamp} ${timestamp} ${now}  ahora
//   {duration} ${duration}         duración en segundos   ({duration:60} = minutos)
//   {offset} ${offset}             segundos desde el inicio hasta ahora ({offset:60}…)
//   {Y} {m} {d} {H} {M} {S}        fecha y hora de inicio (hora local)
//   {utc:Y-m-d H:M:S} ${start:yyyy-MM-dd-HH-mm-ss} …  inicio/fin/ahora con formato

const DAY = 86400000;
const DEFAULT_DAYS = 7;
const MODES = {
  default: 'default', append: 'append', shift: 'shift', timeshift: 'shift',
  flussonic: 'flussonic', 'flussonic-hls': 'flussonic', 'flussonic-ts': 'flussonic', fs: 'flussonic',
  xc: 'xc', xtream: 'xc', 'xtream-codes': 'xc'
};
const XC_RE = /^(https?:\/\/[^/]+)\/(?:live\/)?([^/]+)\/([^/]+)\/(\d+)(?:\.(m3u8|ts))?$/i;
const FLUSSONIC_RE = /^(https?:\/\/[^/]+)\/(.*)\/([^/]*)(mpegts|\.m3u8)(\?.+=.+)?$/i;

/** Datos de catch-up del canal, o null si no tiene. */
export function catchupInfo(channel) {
  const c = channel?.catchup;
  if (!c) return null;
  let mode = MODES[String(c.mode || '').toLowerCase()] || '';
  const days = Math.max(0, Number(c.days) || 0) || DEFAULT_DAYS;
  if (!mode && c.source) mode = /^[a-z]+:\/\//i.test(c.source) ? 'default' : 'append';
  // Solo días de archivo (tvg-rec / timeshift) en una URL de Xtream Codes → formato xc
  if (!mode && XC_RE.test(channel.url)) mode = 'xc';
  if (!mode && c.days) mode = 'shift';
  if (!mode) return null;
  if (mode === 'default' && !c.source) mode = 'shift';
  if (mode === 'xc' && !XC_RE.test(channel.url)) return null;
  if (mode === 'flussonic' && !FLUSSONIC_RE.test(channel.url)) return null;
  return { mode, source: c.source || '', days };
}

/** ¿Se puede ver este programa en diferido? (ya empezado y dentro de los días de archivo) */
export function canCatchup(channel, prog, now = Date.now()) {
  const info = catchupInfo(channel);
  return !!info && !!prog && prog.start < now && prog.start >= now - info.days * DAY;
}

const pad = (n) => String(n).padStart(2, '0');

function formatDate(ms, fmt, utc) {
  const d = new Date(ms);
  const g = (k) => d[`get${utc ? 'UTC' : ''}${k}`]();
  const parts = {
    year: String(g('FullYear')), month: pad(g('Month') + 1), day: pad(g('Date')),
    hour: pad(g('Hours')), min: pad(g('Minutes')), sec: pad(g('Seconds'))
  };
  // TiviMate (yyyy-MM-dd HH:mm:ss) o Kodi (Y-m-d H:M:S)
  if (/yyyy|YYYY|dd|HH|mm|ss/.test(fmt)) {
    return fmt.replace(/yyyy|YYYY|MM|dd|DD|HH|hh|mm|ss|SS/g, (t) => ({
      yyyy: parts.year, YYYY: parts.year, MM: parts.month, dd: parts.day, DD: parts.day,
      HH: parts.hour, hh: parts.hour, mm: parts.min, ss: parts.sec, SS: parts.sec
    })[t]);
  }
  return fmt.replace(/[YmdHMS]/g, (t) => ({ Y: parts.year, m: parts.month, d: parts.day, H: parts.hour, M: parts.min, S: parts.sec })[t]);
}

/** Sustituye los marcadores de una plantilla catchup-source. */
export function fillTemplate(tpl, startMs, endMs, nowMs = Date.now()) {
  const sec = (ms) => Math.floor(ms / 1000);
  const values = {
    utc: startMs, start: startMs, utcend: endMs, end: endMs,
    lutc: nowMs, timestamp: nowMs, now: nowMs
  };
  const duration = Math.max(0, sec(endMs - startMs));
  const offset = Math.max(0, sec(nowMs - startMs));
  return String(tpl || '')
    // {utc:FORMATO} / ${start:FORMATO}
    .replace(/\$?\{(utc|start|utcend|end|lutc|timestamp|now):([^}]+)\}/g, (_, k, fmt) => formatDate(values[k], fmt, k === 'utc' || k === 'utcend' || k === 'lutc'))
    // {duration:60} / {offset:60} → dividido
    .replace(/\$?\{(duration|offset):(\d+)\}/g, (_, k, div) => String(Math.floor((k === 'duration' ? duration : offset) / (Number(div) || 1))))
    .replace(/\$?\{(utc|start|utcend|end|lutc|timestamp|now)\}/g, (_, k) => String(sec(values[k])))
    .replace(/\$?\{duration\}/g, String(duration))
    .replace(/\$?\{offset\}/g, String(offset))
    .replace(/\{([YmdHMS])\}/g, (_, k) => formatDate(startMs, k, false));
}

/**
 * URL del archivo de un programa.
 * @param {object} channel canal con .catchup y .url
 * @param {{start:number, stop:number}} prog programa (ms)
 */
export function catchupUrl(channel, prog, now = Date.now()) {
  const info = catchupInfo(channel);
  if (!info) return '';
  const start = prog.start;
  const end = Math.min(prog.stop, Math.max(now, start + 60000));
  const fill = (tpl) => fillTemplate(tpl, start, prog.stop > now ? end : prog.stop, now);
  const url = channel.url;
  switch (info.mode) {
    case 'default':
      return fill(info.source);
    case 'append':
      return url + fill(info.source);
    case 'shift':
      return url + (url.includes('?') ? '&' : '?') + fill('utc={utc}&lutc={lutc}');
    case 'flussonic': {
      const m = url.match(FLUSSONIC_RE);
      const [, host, stream, file, kind, query = ''] = m;
      if (/mpegts/i.test(kind)) return fill(`${host}/${stream}/timeshift_abs-{utc}.ts`) + query;
      return fill(`${host}/${stream}/${file || 'index'}-{utc}-{duration}.m3u8`) + query;
    }
    case 'xc': {
      const [, host, user, pass, id, ext = 'ts'] = url.match(XC_RE);
      return fill(`${host}/timeshift/${user}/${pass}/{duration:60}/{Y}-{m}-{d}:{H}-{M}/${id}.${ext}`);
    }
    default:
      return '';
  }
}
