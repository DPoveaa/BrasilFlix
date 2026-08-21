/**
 * PriorityService.js
 * Serviço que gerencia as prioridades da fila de forma configurável pelo admin.
 * As prioridades são armazenadas no banco e podem ser ajustadas em tempo real via painel admin.
 *
 * Menor número = maior prioridade (1 = fura-fila, 10 = ultrabaixo)
 */

const db = require('../database/db');

// Prioridades padrão de fábrica (usadas se não houver configuração no banco)
const DEFAULT_PRIORITIES = {
    VIP_USER:  1,  // Pedido de Assinante VIP (Fura-fila Máxima)
    USER:      1,  // Alias de compatibilidade para VIP_USER
    SERIES:    2,  // Continuação / Finalização de série do catálogo
    FREE_USER: 3,  // Pedido de Usuário Gratuito / Normal
    ANIME:     4,  // Episódios de anime (menor peso que séries ocidentais)
    FEEDER:    5   // Auto-Feeder (Sugestão do sistema em background)
};

// Labels para exibição na UI
const PRIORITY_LABELS = {
    VIP_USER:  'Cliente VIP / Assinante',
    SERIES:    'Série já no catálogo (próx. episódio)',
    FREE_USER: 'Cliente Gratuito',
    ANIME:     'Anime',
    FEEDER:    'Auto-Feeder (sugestões automáticas)'
};

class PriorityService {
    constructor() {
        this._priorities = { ...DEFAULT_PRIORITIES };
        this._loaded = false;
    }

    /**
     * Carrega as prioridades do banco de dados (ou usa o padrão se ainda não existem).
     * Deve ser chamado uma vez na inicialização.
     */
    async load() {
        try {
            // Garante que a tabela existe
            await db.query(`
                CREATE TABLE IF NOT EXISTS system_settings (
                    key VARCHAR(100) PRIMARY KEY,
                    value JSONB NOT NULL,
                    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
                )
            `);

            const res = await db.query(`SELECT value FROM system_settings WHERE key = 'priorities'`);
            if (res.rowCount > 0) {
                const saved = res.rows[0].value;
                // Mescla com defaults para garantir que novas chaves futuras também sejam preenchidas
                this._priorities = { ...DEFAULT_PRIORITIES, ...saved };
                console.log('✅ [PriorityService] Prioridades carregadas do banco:', this._priorities);
            } else {
                // Salva os defaults no banco na primeira execução
                await this.save(DEFAULT_PRIORITIES);
                console.log('✅ [PriorityService] Prioridades padrão registradas no banco.');
            }
            this._loaded = true;
        } catch (e) {
            console.warn('⚠️ [PriorityService] Falha ao carregar prioridades do banco, usando padrões:', e.message);
            this._priorities = { ...DEFAULT_PRIORITIES };
            this._loaded = true;
        }
    }

    /**
     * Salva as prioridades atualizadas no banco.
     * @param {Object} newPriorities - Mapa { VIP_USER: 1, SERIES: 2, ... }
     */
    async save(newPriorities) {
        // Valida que todos os valores são números entre 1 e 10
        for (const [key, val] of Object.entries(newPriorities)) {
            const n = Number(val);
            if (!Number.isInteger(n) || n < 1 || n > 10) {
                throw new Error(`Valor inválido para prioridade "${key}": deve ser inteiro entre 1 e 10.`);
            }
        }

        // Apenas chaves conhecidas são permitidas
        const allowed = new Set(Object.keys(DEFAULT_PRIORITIES));
        const filtered = {};
        for (const key of allowed) {
            if (newPriorities[key] !== undefined) {
                filtered[key] = Number(newPriorities[key]);
            } else {
                filtered[key] = this._priorities[key] ?? DEFAULT_PRIORITIES[key];
            }
        }

        await db.query(`
            INSERT INTO system_settings (key, value, updated_at)
            VALUES ('priorities', $1::jsonb, NOW())
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        `, [JSON.stringify(filtered)]);

        this._priorities = filtered;
        // Mantém USER sincronizado com VIP_USER para compatibilidade
        this._priorities.USER = this._priorities.VIP_USER;
        return this._priorities;
    }

    /**
     * Retorna as prioridades atuais.
     */
    get(key = null) {
        if (!this._loaded) return key ? DEFAULT_PRIORITIES[key] ?? 5 : { ...DEFAULT_PRIORITIES };
        if (key) return this._priorities[key] ?? DEFAULT_PRIORITIES[key] ?? 5;
        return { ...this._priorities };
    }

    /**
     * Retorna o mapa completo para exibição na UI (com labels).
     */
    getForUI() {
        const current = this.get();
        return Object.entries(PRIORITY_LABELS).map(([key, label]) => ({
            key,
            label,
            value: current[key] ?? DEFAULT_PRIORITIES[key],
            default: DEFAULT_PRIORITIES[key]
        }));
    }
}

// Singleton
const instance = new PriorityService();
module.exports = instance;
