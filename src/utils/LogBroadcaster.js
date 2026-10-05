/**
 * LogBroadcaster — Singleton de logs em tempo real para o painel Admin.
 *
 * Estratégia:
 *  • Intercepta console.log / console.warn / console.error globalmente (uma vez).
 *  • Mantém um circular buffer de MAX_LINES linhas em memória (sem banco de dados).
 *  • Distribui cada nova entrada para todos os clientes SSE conectados via push.
 *  • Clientes recebem o histórico recente ao conectar e depois ficam em streaming.
 *  • Zero overhead quando não há clientes conectados (push imediato, sem polling).
 */

'use strict';

const MAX_LINES    = 300;   // Máximo de linhas mantidas em memória
const MAX_CLIENTS  = 20;    // Máximo de clientes SSE simultâneos por segurança
const HEARTBEAT_MS = 25000; // Intervalo do keep-alive (evita timeout de proxy/CDN)

class LogBroadcaster {
    constructor() {
        /** @type {Array<{ts: string, level: string, text: string}>} */
        this._buffer  = [];
        /** @type {Map<string, import('http').ServerResponse>} */
        this._clients = new Map();
        this._intercepted = false;
        this._heartbeatTimer = null;
    }

    /** Ativa a interceptação do console (chamar uma única vez na inicialização). */
    install() {
        if (this._intercepted) return;
        this._intercepted = true;

        const self = this;
        const _orig = {
            log  : console.log.bind(console),
            warn : console.warn.bind(console),
            error: console.error.bind(console),
            info : console.info.bind(console),
        };

        ['log', 'info', 'warn', 'error'].forEach(level => {
            console[level] = (...args) => {
                _orig[level](...args);  // mantém saída normal no terminal do servidor
                self._push(level, args);
            };
        });

        // Heartbeat periódico para manter conexões SSE vivas
        this._heartbeatTimer = setInterval(() => {
            if (this._clients.size === 0) return;
            const ping = ': ping\n\n';
            for (const [id, res] of this._clients) {
                try { res.write(ping); } catch (_) { this._removeClient(id); }
            }
        }, HEARTBEAT_MS);

        // Não bloqueia shutdown do processo
        if (this._heartbeatTimer.unref) this._heartbeatTimer.unref();
    }

    /** Formata args do console em texto limpo (sem ANSI). */
    _formatArgs(args) {
        return args.map(a => {
            if (typeof a === 'string') return a;
            try { return JSON.stringify(a); } catch (_) { return String(a); }
        }).join(' ').replace(/\x1b\[[0-9;]*m/g, ''); // strip ANSI colors
    }

    /** Adiciona uma linha ao buffer e notifica clientes. */
    _push(level, args) {
        const ts   = new Date().toLocaleTimeString('pt-BR', { hour12: false });
        const text = this._formatArgs(args);
        if (!text.trim()) return;

        const entry = { ts, level, text };

        // Circular buffer: remove o mais antigo se cheio
        if (this._buffer.length >= MAX_LINES) {
            this._buffer.shift();
        }
        this._buffer.push(entry);

        // Broadcast apenas se houver clientes
        if (this._clients.size === 0) return;
        const payload = `data: ${JSON.stringify(entry)}\n\n`;
        for (const [id, res] of this._clients) {
            try { res.write(payload); } catch (_) { this._removeClient(id); }
        }
    }

    /** Registra um cliente SSE e envia o histórico recente imediatamente. */
    addClient(id, res) {
        if (this._clients.size >= MAX_CLIENTS) {
            // Remove o cliente mais antigo para dar lugar ao novo
            const oldestId = this._clients.keys().next().value;
            this._removeClient(oldestId);
        }

        this._clients.set(id, res);

        // Envia histórico buffered ao conectar
        for (const entry of this._buffer) {
            try {
                res.write(`data: ${JSON.stringify(entry)}\n\n`);
            } catch (_) {
                this._removeClient(id);
                return;
            }
        }
    }

    /** Remove cliente SSE (desconexão ou erro). */
    _removeClient(id) {
        const res = this._clients.get(id);
        if (res) {
            try { res.end(); } catch (_) {}
        }
        this._clients.delete(id);
    }

    removeClient(id) {
        this._removeClient(id);
    }

    /** Retorna uma cópia do buffer atual (para o endpoint REST /history). */
    getHistory(limit = MAX_LINES) {
        const n = Math.min(Math.max(1, limit), MAX_LINES);
        return this._buffer.slice(-n);
    }

    get clientCount() {
        return this._clients.size;
    }
}

// Exporta instância única (singleton)
module.exports = new LogBroadcaster();
