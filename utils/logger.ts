export class Logger {
  constructor(private context: string) {}
  info(msg, data?) { console.log(`[${this.context}] ${msg}`, data || ''); }
  warn(msg, data?) { console.warn(`[${this.context}] ${msg}`, data || ''); }
  error(msg, err?) { console.error(`[${this.context}] ${msg}`, err || ''); }
}
