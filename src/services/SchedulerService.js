const fs = require('fs-extra');
const path = require('path');
const EventEmitter = require('events');

// Utilitários para conversão de tempo flexível (HH:mm ou minutos como "05:30" => 330)
function timeToMinutes(val, defaultMin = 0) {
    if (val === null || val === undefined) return defaultMin;
    if (typeof val === 'number') {
        return val <= 24 ? Math.round(val * 60) : val;
    }
    if (typeof val === 'string') {
        if (val.includes(':')) {
            const parts = val.split(':');
            const h = parseInt(parts[0], 10) || 0;
            const m = parseInt(parts[1], 10) || 0;
            return (h * 60) + m;
        }
        const num = parseFloat(val);
        if (!isNaN(num)) {
            return num <= 24 ? Math.round(num * 60) : Math.round(num);
        }
    }
    return defaultMin;
}

function minutesToTimeStr(min) {
    const h = Math.floor(min / 60) % 24;
    const m = min % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

class SchedulerService extends EventEmitter {
    constructor() {
        super();
        this.dataPath = path.join(__dirname, '../../data/scheduler.json');

        // Grade padrão inteligente:
        // Seg-Sex: Desempenho (01:00 às 05:30), Econômico no restante do dia (05:30 às 01:00)
        // Sáb-Dom: Econômico 24h (não interfere na rede da família/celulares)
        this.defaultConfig = {
            ativo: true,
            modoPadraoForaHorario: 'eco', // 'eco' (padrão residencial) ou 'paused'
            // Grade individualizada por dia da semana (0=Dom, 1=Seg, ..., 6=Sáb)
            dias: {
                "0": { "ativo": true, "modo": "eco", "horaInicio": "00:00", "horaFim": "23:59", "modoFora": "paused", "nome": "Domingo" },
                "1": { "ativo": true, "modo": "performance", "horaInicio": "01:00", "horaFim": "05:30", "modoFora": "eco", "nome": "Segunda" },
                "2": { "ativo": true, "modo": "performance", "horaInicio": "01:00", "horaFim": "05:30", "modoFora": "eco", "nome": "Terça" },
                "3": { "ativo": true, "modo": "performance", "horaInicio": "01:00", "horaFim": "05:30", "modoFora": "eco", "nome": "Quarta" },
                "4": { "ativo": true, "modo": "performance", "horaInicio": "01:00", "horaFim": "05:30", "modoFora": "eco", "nome": "Quinta" },
                "5": { "ativo": true, "modo": "performance", "horaInicio": "01:00", "horaFim": "05:30", "modoFora": "eco", "nome": "Sexta" },
                "6": { "ativo": true, "modo": "eco", "horaInicio": "00:00", "horaFim": "23:59", "modoFora": "paused", "nome": "Sábado" }
            },
            // Compatibilidade com UI simplificada
            diasSemana: [1, 2, 3, 4, 5],
            horaInicio: '01:00',
            horaFim: '05:30'
        };

        // Overrides por data específica: chave = "YYYY-MM-DD", valor = { modo, horaInicio, horaFim, modoFora } ou false (desabilitar)
        this.overrides = {};

        // Controle manual: null = seguir grade, 'performance' = forçar desempenho, 'eco' = forçar econômico, 'stop' = pausar tudo
        this.forceState = null;
        this.forceReason = null;
        this.forceExpiresAt = null;
        this.forceExpiresAtDesc = null;

        this._config = JSON.parse(JSON.stringify(this.defaultConfig));
        this._schedulerTickInterval = null;
        this._lastStatusKey = null;

        this._load();
        this._startTick();
    }

    // ─── Persistência ────────────────────────────────────────────────────────

    _load() {
        try {
            if (fs.existsSync(this.dataPath)) {
                const saved = fs.readJsonSync(this.dataPath);
                if (saved.config) {
                    this._config = {
                        ...this.defaultConfig,
                        ...saved.config,
                        dias: { ...this.defaultConfig.dias, ...(saved.config.dias || {}) }
                    };
                }
                if (saved.overrides) this.overrides = saved.overrides || {};
                if (saved.forceState !== undefined) this.forceState = saved.forceState || null;
                if (saved.forceReason !== undefined) this.forceReason = saved.forceReason || null;
                if (saved.forceExpiresAt !== undefined) this.forceExpiresAt = saved.forceExpiresAt || null;
                if (saved.forceExpiresAtDesc !== undefined) this.forceExpiresAtDesc = saved.forceExpiresAtDesc || null;
                console.log(`⏱️  [Scheduler] Configuração carregada: Modo Atual = ${this.getActiveMode()} | ForceState: ${this.forceState || 'nenhum'}`);
            } else {
                this._save();
                console.log('⏱️  [Scheduler] Arquivo de configuração criado com padrão: Desempenho (01:00-05:30) + Econômico residencial 24h.');
            }
        } catch (e) {
            console.warn('⚠️  [Scheduler] Erro ao carregar configuração:', e.message);
        }
    }

    _save() {
        try {
            fs.ensureDirSync(path.dirname(this.dataPath));
            fs.writeJsonSync(this.dataPath, {
                config: this._config,
                overrides: this.overrides,
                forceState: this.forceState,
                forceReason: this.forceReason,
                forceExpiresAt: this.forceExpiresAt,
                forceExpiresAtDesc: this.forceExpiresAtDesc,
                updatedAt: new Date().toISOString()
            }, { spaces: 2 });
        } catch (e) {
            console.warn('⚠️  [Scheduler] Erro ao salvar configuração:', e.message);
        }
    }

    // ─── Utilitários de Tempo (Horário de São Paulo - America/Sao_Paulo) ───

    _getSaoPauloTime(customDate = null) {
        const targetDate = customDate || new Date();
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Sao_Paulo',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
            weekday: 'short'
        });
        const parts = formatter.formatToParts(targetDate);
        const map = {};
        parts.forEach(p => map[p.type] = p.value);

        const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
        const diaSemana = weekdayMap[map.weekday] ?? 0;
        const hora = parseInt(map.hour, 10) % 24;
        const minuto = parseInt(map.minute, 10);
        const dataKey = `${map.year}-${map.month}-${map.day}`;

        return { diaSemana, hora, minuto, dataKey };
    }

    // ─── Determinação Dinâmica do Modo de Operação ───────────────────────────

    /**
     * Retorna o modo atual ('performance', 'eco' ou 'paused') e se a esteira está autorizada a rodar.
     */
    getCurrentMode() {
        // Scheduler desabilitado globalmente = Desempenho 24h
        if (!this._config.ativo) {
            return {
                allowed: true,
                mode: 'performance',
                reason: 'Agendador desativado (Modo Desempenho 24h sem restrições)'
            };
        }

        // Force stop manual
        if (this.forceState === 'stop') {
            return {
                allowed: false,
                mode: 'paused',
                reason: `Pausado manualmente: ${this.forceReason || 'via painel admin'}`
            };
        }

        // Force start manual (performance ou eco)
        if (this.forceState === 'performance' || this.forceState === 'start' || this.forceState === 'eco') {
            if (this.forceExpiresAt && Date.now() >= this.forceExpiresAt) {
                console.log(`⏰ [Scheduler SP] Expiração do modo manual atingida (${this.forceExpiresAtDesc || 'agendada'}). Voltando à grade automática.`);
                this.forceState = null;
                this.forceReason = null;
                this.forceExpiresAt = null;
                this.forceExpiresAtDesc = null;
                this._save();
                this.emit('stateChange', { allowed: this.isAllowedToRun(), mode: this.getActiveMode(), reason: 'Expirou modo manual' });
            } else {
                const targetMode = this.forceState === 'eco' ? 'eco' : 'performance';
                const desc = this.forceExpiresAtDesc ? ` (até ${this.forceExpiresAtDesc})` : '';
                return {
                    allowed: true,
                    mode: targetMode,
                    reason: `Forçado manualmente em ${targetMode === 'eco' ? 'Modo Econômico (Sem interferir na rede)' : 'Modo Desempenho'}${desc}`
                };
            }
        }

        const { diaSemana, hora, minuto, dataKey } = this._getSaoPauloTime();
        const currentMinutes = (hora * 60) + minuto;

        // 1. Verifica override/exceção por data específica (YYYY-MM-DD)
        if (this.overrides.hasOwnProperty(dataKey)) {
            const ov = this.overrides[dataKey];
            if (ov === false) {
                return { allowed: false, mode: 'paused', reason: `Data ${dataKey} bloqueada por exceção manual (Pausa Total)` };
            }
            if (typeof ov === 'object' && ov !== null) {
                const iniMin = timeToMinutes(ov.horaInicio, 0);
                const fimMin = timeToMinutes(ov.horaFim, 1439);
                const inside = currentMinutes >= iniMin && currentMinutes < fimMin;
                if (inside) {
                    const mode = ov.modo || 'performance';
                    return {
                        allowed: mode !== 'paused',
                        mode: mode,
                        reason: `Exceção para hoje (${dataKey}): ${mode === 'eco' ? 'Modo Econômico' : 'Modo Desempenho'} das ${ov.horaInicio} às ${ov.horaFim}`
                    };
                }
                // Se estiver fora do horário da exceção e tiver sido definido explicitamente um modoFora diferente do padrão (ex: 'paused'), aplica.
                // Caso contrário, continua para a grade regular do dia da semana (respeita o horário padrão da madrugada).
                if (ov.modoFora && ov.modoFora === 'paused') {
                    return { allowed: false, mode: 'paused', reason: `Fora da janela de exceção de ${dataKey} (Pausado conforme configuração da exceção)` };
                }
            }
        }

        // 2. Verifica a programação por dia da semana
        const diaConfig = (this._config.dias && this._config.dias[String(diaSemana)]) || null;
        if (diaConfig) {
            if (diaConfig.ativo === false) {
                const offMode = diaConfig.modoFora || 'paused';
                if (offMode === 'paused') {
                    return { allowed: false, mode: 'paused', reason: `${diaConfig.nome || 'Dia'} configurado como inativo` };
                }
                return { allowed: true, mode: 'eco', reason: `${diaConfig.nome || 'Dia'} inativo para desempenho (Operando em Modo Econômico)` };
            }

            const iniMin = timeToMinutes(diaConfig.horaInicio, 60);
            const fimMin = timeToMinutes(diaConfig.horaFim, 330);
            const isInside = currentMinutes >= iniMin && currentMinutes < fimMin;

            if (isInside) {
                const mode = diaConfig.modo || 'performance';
                return {
                    allowed: mode !== 'paused',
                    mode: mode,
                    reason: `${diaConfig.nome || 'Hoje'} (${diaConfig.horaInicio} às ${diaConfig.horaFim}): ${mode === 'eco' ? 'Modo Econômico Residencial' : 'Modo Desempenho Máximo'}`
                };
            } else {
                const fallbackMode = diaConfig.modoFora || this._config.modoPadraoForaHorario || 'eco';
                if (fallbackMode === 'paused') {
                    return { allowed: false, mode: 'paused', reason: `Fora da janela de ${diaConfig.nome || 'hoje'} (Pausado conforme grade)` };
                }
                return {
                    allowed: true,
                    mode: 'eco',
                    reason: `Fora da janela de ${diaConfig.nome || 'hoje'} (Operando em Modo Econômico sem interferir na rede)`
                };
            }
        }

        // 3. Fallback legado simples
        const isDiaSemanaAtivo = (this._config.diasSemana || [1,2,3,4,5]).includes(diaSemana);
        const iniMin = timeToMinutes(this._config.horaInicio, 60);
        const fimMin = timeToMinutes(this._config.horaFim, 330);
        const isPeak = isDiaSemanaAtivo && (currentMinutes >= iniMin && currentMinutes < fimMin);

        if (isPeak) {
            return { allowed: true, mode: 'performance', reason: 'Janela de Desempenho Máximo (Madrugada)' };
        }

        const defaultOff = this._config.modoPadraoForaHorario || 'eco';
        if (defaultOff === 'paused') {
            return { allowed: false, mode: 'paused', reason: 'Fora do horário programado (Pausado)' };
        }

        return { allowed: true, mode: 'eco', reason: 'Fora do horário de pico: Operando em Modo Econômico sem afetar celulares' };
    }

    /**
     * Retorna true se a esteira tem autorização para rodar agora
     */
    isAllowedToRun() {
        return this.getCurrentMode().allowed;
    }

    /**
     * Retorna o modo ativo: 'performance', 'eco' ou 'paused'
     */
    getActiveMode() {
        return this.getCurrentMode().mode;
    }

    /**
     * Retorna o status completo e detalhes para o Painel Web
     */
    getStatus() {
        const { diaSemana, hora, minuto, dataKey } = this._getSaoPauloTime();
        const current = this.getCurrentMode();
        const diasNomes = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

        return {
            allowed: current.allowed,
            mode: current.mode, // 'performance', 'eco', 'paused'
            motivo: current.reason,
            forceState: this.forceState,
            forceReason: this.forceReason,
            forceExpiresAt: this.forceExpiresAt,
            forceExpiresAtDesc: this.forceExpiresAtDesc,
            dataAtualSP: dataKey,
            horaAtualBRT: `${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')}`,
            diaAtualBRT: diaSemana,
            diaNomeAtual: diasNomes[diaSemana],
            timezone: 'America/Sao_Paulo (Horário de Brasília/SP)',
            config: this._config,
            overrides: this.overrides
        };
    }

    // ─── Controles Manuais ────────────────────────────────────────────────────

    forceStart(reason = 'Manual via painel admin', targetMode = 'performance', durationHours = 4) {
        this.forceState = targetMode === 'eco' ? 'eco' : 'performance';
        this.forceReason = reason;
        const now = new Date();
        const expires = new Date(now.getTime() + (durationHours * 60 * 60 * 1000));
        this.forceExpiresAt = expires.getTime();
        this.forceExpiresAtDesc = expires.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
        this._save();
        console.log(`▶️  [Scheduler] Modo manual acionado: ${this.forceState} (até ${this.forceExpiresAtDesc} SP) - Motivo: ${reason}`);
        this.emit('stateChange', { allowed: true, mode: this.forceState, reason });
    }

    forceStop(reason = 'Manual via painel admin') {
        this.forceState = 'stop';
        this.forceReason = reason;
        this.forceExpiresAt = null;
        this.forceExpiresAtDesc = null;
        this._save();
        console.log(`⏹  [Scheduler] Pausa manual total acionada: ${reason}`);
        this.emit('stateChange', { allowed: false, mode: 'paused', reason });
    }

    clearForce() {
        this.forceState = null;
        this.forceReason = null;
        this.forceExpiresAt = null;
        this.forceExpiresAtDesc = null;
        this._save();
        const current = this.getCurrentMode();
        console.log('🔄 [Scheduler] Controle manual removido — voltando à programação automática.');
        this.emit('stateChange', { allowed: current.allowed, mode: current.mode, reason: 'Grade automática restaurada' });
    }

    // ─── Atualização de Configuração ──────────────────────────────────────────

    updateConfig(newConfig = {}) {
        if (newConfig.ativo !== undefined) this._config.ativo = Boolean(newConfig.ativo);
        if (newConfig.modoPadraoForaHorario !== undefined) this._config.modoPadraoForaHorario = newConfig.modoPadraoForaHorario;

        // Se enviou configuração individual de dias
        if (newConfig.dias && typeof newConfig.dias === 'object') {
            for (const [dKey, dVal] of Object.entries(newConfig.dias)) {
                if (this._config.dias[dKey]) {
                    this._config.dias[dKey] = {
                        ...this._config.dias[dKey],
                        ...dVal
                    };
                }
            }
        }

        // Se enviou horários quebrados padrão
        if (newConfig.horaInicio) this._config.horaInicio = String(newConfig.horaInicio);
        if (newConfig.horaFim) this._config.horaFim = String(newConfig.horaFim);
        if (Array.isArray(newConfig.diasSemana)) this._config.diasSemana = newConfig.diasSemana.map(Number);

        this._save();
        console.log('⚙️  [Scheduler] Grade de horários atualizada com sucesso!');
        const current = this.getCurrentMode();
        this.emit('stateChange', { allowed: current.allowed, mode: current.mode, reason: 'Configuração atualizada' });
    }

    setOverride(data, config) {
        if (config === false || config === null) {
            this.overrides[data] = false;
        } else {
            this.overrides[data] = {
                modo: config.modo || 'performance',
                horaInicio: config.horaInicio || '01:00',
                horaFim: config.horaFim || '05:30',
                modoFora: config.modoFora || 'eco'
            };
        }
        this._save();
        console.log(`📅 [Scheduler] Exceção salva para ${data}:`, this.overrides[data]);
        const current = this.getCurrentMode();
        this.emit('stateChange', { allowed: current.allowed, mode: current.mode, reason: `Exceção de ${data}` });
    }

    removeOverride(data) {
        if (this.overrides.hasOwnProperty(data)) {
            delete this.overrides[data];
            this._save();
            console.log(`🗑️  [Scheduler] Exceção removida para ${data}`);
            const current = this.getCurrentMode();
            this.emit('stateChange', { allowed: current.allowed, mode: current.mode, reason: `Exceção de ${data} removida` });
        }
    }

    // ─── Loop de Verificação em Tempo Real (60s) ──────────────────────────────

    _startTick() {
        this._schedulerTickInterval = setInterval(() => {
            const current = this.getCurrentMode();
            const key = `${current.allowed}_${current.mode}`;
            if (this._lastStatusKey !== null && this._lastStatusKey !== key) {
                console.log(`⏰ [Scheduler] Mudança de estado da esteira: ${current.reason} [Modo: ${current.mode.toUpperCase()}]`);
                this.emit('stateChange', { allowed: current.allowed, mode: current.mode, reason: current.reason });
            }
            this._lastStatusKey = key;
        }, 30 * 1000);

        if (this._schedulerTickInterval.unref) this._schedulerTickInterval.unref();
    }
}

module.exports = new SchedulerService();
