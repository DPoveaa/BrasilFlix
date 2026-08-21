const fs = require('fs-extra');
const path = require('path');
const EventEmitter = require('events');

// Utilitários para conversão de tempo flexível (horas cheias ou HH:mm como 05:30)
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

        // Grade padrão: Seg-Sex (1-5), 01:00 às 05:00 no horário de Brasília
        this.defaultConfig = {
            ativo: true,             // Se o scheduler está habilitado. false = roda 24h
            diasSemana: [1, 2, 3, 4, 5], // 0=Dom, 1=Seg, ..., 6=Sab
            horaInicio: '01:00',     // hora de início (HH:mm ou número)
            horaFim: '05:00'         // hora de término (HH:mm ou número)
        };

        // Overrides por data: chave = "YYYY-MM-DD", valor = { horaInicio, horaFim } ou false (desabilitar)
        this.overrides = {};

        // Controle manual: null = seguir grade, 'start' = forçar ligado, 'stop' = forçar parado
        this.forceState = null;
        this.forceReason = null;
        this.forceExpiresAt = null;
        this.forceExpiresAtDesc = null;

        this._config = { ...this.defaultConfig };
        this._schedulerTickInterval = null;
        this._lastAllowed = null; // para detectar mudanças de estado e logar

        this._load();
        this._startTick();
    }

    // ─── Persistência ────────────────────────────────────────────────────────

    _load() {
        try {
            if (fs.existsSync(this.dataPath)) {
                const saved = fs.readJsonSync(this.dataPath);
                if (saved.config) this._config = { ...this.defaultConfig, ...saved.config };
                if (saved.overrides) this.overrides = saved.overrides || {};
                if (saved.forceState !== undefined) this.forceState = saved.forceState || null;
                if (saved.forceReason !== undefined) this.forceReason = saved.forceReason || null;
                if (saved.forceExpiresAt !== undefined) this.forceExpiresAt = saved.forceExpiresAt || null;
                if (saved.forceExpiresAtDesc !== undefined) this.forceExpiresAtDesc = saved.forceExpiresAtDesc || null;
                console.log(`⏱️  [Scheduler] Configuração carregada: ${JSON.stringify(this._config)} | Overrides: ${Object.keys(this.overrides).length} | ForceState: ${this.forceState || 'nenhum'} | Expira: ${this.forceExpiresAtDesc || 'n/a'}`);
            } else {
                this._save();
                console.log('⏱️  [Scheduler] Arquivo de configuração criado com padrão Seg-Sex 01:00-05:00 (Horário de SP).');
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

    // ─── Lógica Principal ─────────────────────────────────────────────────────

    /**
     * Retorna true se download/upload pela rede está autorizado neste momento no Horário de São Paulo.
     */
    isAllowedToRun() {
        // Scheduler desabilitado globalmente = sempre roda
        if (!this._config.ativo) return true;

        // Force stop manual tem prioridade máxima
        if (this.forceState === 'stop') return false;

        // Force start manual: permite rodar até atingir o próximo encerramento agendado
        if (this.forceState === 'start') {
            if (this.forceExpiresAt && Date.now() >= this.forceExpiresAt) {
                console.log(`⏰ [Scheduler SP] Horário de encerramento agendado atingido (${this.forceExpiresAtDesc || '05:00'}). Início manual expirado com sucesso — pausando robô conforme a programação.`);
                this.forceState = null;
                this.forceReason = null;
                this.forceExpiresAt = null;
                this.forceExpiresAtDesc = null;
                this._save();
                this.emit('stateChange', { allowed: false, reason: 'Horário de término agendado atingido' });
                return false;
            }
            return true;
        }

        const { diaSemana, hora, minuto, dataKey } = this._getSaoPauloTime();
        const currentMinutes = (hora * 60) + minuto;

        // Verifica override da data de hoje
        if (this.overrides.hasOwnProperty(dataKey)) {
            const ov = this.overrides[dataKey];
            if (ov === false) return false; // Dia bloqueado por override
            if (typeof ov === 'object' && ov !== null) {
                const iniMin = timeToMinutes(ov.horaInicio, 60);
                const fimMin = timeToMinutes(ov.horaFim, 300);
                return currentMinutes >= iniMin && currentMinutes < fimMin;
            }
        }

        // Aplica a grade padrão
        if (!this._config.diasSemana.includes(diaSemana)) return false;

        const iniMin = timeToMinutes(this._config.horaInicio, 60);
        const fimMin = timeToMinutes(this._config.horaFim, 300);
        return currentMinutes >= iniMin && currentMinutes < fimMin;
    }

    /**
     * Retorna detalhes do estado atual para a API.
     */
    getStatus() {
        const { diaSemana, hora, minuto, dataKey } = this._getSaoPauloTime();
        const allowed = this.isAllowedToRun();

        let motivo = '';
        if (!this._config.ativo) {
            motivo = 'Scheduler desabilitado — rodando 24h';
        } else if (this.forceState === 'stop') {
            motivo = `⏹ Parado manualmente: ${this.forceReason || 'via painel admin'}`;
        } else if (this.forceState === 'start') {
            const expStr = this.forceExpiresAtDesc ? ` (pausará automaticamente às ${this.forceExpiresAtDesc})` : '';
            motivo = `▶️ Iniciado manualmente${expStr}`;
        } else if (this.overrides.hasOwnProperty(dataKey)) {
            const ov = this.overrides[dataKey];
            if (ov === false) motivo = `Override: dia ${dataKey} bloqueado`;
            else motivo = `Override SP: hoje das ${ov.horaInicio}h às ${ov.horaFim}h (Horário de São Paulo)`;
        } else {
            const diasNomes = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
            const diasAtivos = this._config.diasSemana.map(d => diasNomes[d]).join(', ');
            motivo = `Grade padrão: ${diasAtivos} das ${this._config.horaInicio}h às ${this._config.horaFim}h (Horário de São Paulo)`;
        }

        // Próxima janela de execução
        const proximaJanela = this._calcProximaJanela();

        return {
            allowed,
            forceState: this.forceState,
            forceReason: this.forceReason,
            forceExpiresAt: this.forceExpiresAt,
            forceExpiresAtDesc: this.forceExpiresAtDesc,
            motivo,
            dataAtualSP: dataKey,
            horaAtualBRT: hora,
            minutoAtualBRT: minuto,
            diaAtualBRT: diaSemana,
            timezone: 'America/Sao_Paulo (Horário de Brasília/SP)',
            config: this._config,
            overrides: this.overrides,
            proximaJanela
        };
    }

    _calcProximaJanela() {
        if (!this._config.ativo) return null;
        if (this.forceState === 'start') return { tipo: 'ativa agora (forçado)', expiraEm: this.forceExpiresAtDesc };

        const diasNomes = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
        const now = new Date();

        // Verifica os próximos 8 dias no fuso horário de São Paulo
        for (let delta = 0; delta <= 8; delta++) {
            const candidato = new Date(now.getTime() + delta * 24 * 60 * 60 * 1000);
            const { diaSemana: diaCandidato, hora: horaCandidato, minuto: minutoCandidato, dataKey: dataCandidato } = this._getSaoPauloTime(candidato);
            const currentMin = (horaCandidato * 60) + minutoCandidato;

            let hIni, hFim;
            if (this.overrides.hasOwnProperty(dataCandidato)) {
                const ov = this.overrides[dataCandidato];
                if (ov === false) continue;
                if (typeof ov === 'object') { hIni = ov.horaInicio; hFim = ov.horaFim; }
            } else {
                if (!this._config.diasSemana.includes(diaCandidato)) continue;
                hIni = this._config.horaInicio;
                hFim = this._config.horaFim;
            }

            const fimMin = timeToMinutes(hFim, 300);
            if (delta === 0 && currentMin >= fimMin) continue;

            const hIniStr = typeof hIni === 'number' && hIni <= 24 ? minutesToTimeStr(hIni * 60) : String(hIni);
            const hFimStr = typeof hFim === 'number' && hFim <= 24 ? minutesToTimeStr(hFim * 60) : String(hFim);

            return {
                data: dataCandidato,
                dia: diasNomes[diaCandidato],
                horaInicio: hIniStr,
                horaFim: hFimStr,
                descricao: `${diasNomes[diaCandidato]} (${dataCandidato}) das ${hIniStr} às ${hFimStr} (Horário de SP)`
            };
        }

        return null;
    }

    /**
     * Calcula o próximo horário de encerramento agendado (timestamp e texto) no Horário de São Paulo.
     */
    _calcNextScheduledStopTime() {
        const now = new Date();
        const diasNomes = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

        for (let delta = 0; delta <= 8; delta++) {
            const candidato = new Date(now.getTime() + delta * 24 * 60 * 60 * 1000);
            const { diaSemana, hora, minuto, dataKey } = this._getSaoPauloTime(candidato);
            const currentMin = (hora * 60) + minuto;

            let hFim = null;
            if (this.overrides.hasOwnProperty(dataKey)) {
                const ov = this.overrides[dataKey];
                if (ov && typeof ov === 'object') {
                    hFim = ov.horaFim;
                }
            } else if (this._config.diasSemana.includes(diaSemana)) {
                hFim = this._config.horaFim;
            }

            if (hFim !== null) {
                const fimMin = timeToMinutes(hFim, 300);
                // Se for hoje e já passou do horário de encerramento, procura o próximo dia
                if (delta === 0 && currentMin >= fimMin) {
                    continue;
                }

                // Cria o timestamp exato do encerramento (no fuso de SP: UTC-3)
                const [year, month, day] = dataKey.split('-').map(Number);
                const fimHour = Math.floor(fimMin / 60);
                const fimMinute = fimMin % 60;
                const stopDateUtc = new Date(Date.UTC(year, month - 1, day, fimHour + 3, fimMinute, 0));
                const hFimStr = minutesToTimeStr(fimMin);

                return {
                    iso: stopDateUtc.toISOString(),
                    timestamp: stopDateUtc.getTime(),
                    data: dataKey,
                    horaFim: hFimStr,
                    descricao: `${diasNomes[diaSemana]} (${dataKey}) às ${hFimStr} (Horário de SP)`
                };
            }
        }

        // Fallback: 12 horas
        const fallbackStop = new Date(now.getTime() + 12 * 60 * 60 * 1000);
        return {
            iso: fallbackStop.toISOString(),
            timestamp: fallbackStop.getTime(),
            descricao: `em 12h (${fallbackStop.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })})`
        };
    }

    // ─── Controles Manuais ────────────────────────────────────────────────────

    forceStart(reason = 'Manual via painel admin') {
        this.forceState = 'start';
        this.forceReason = reason;
        const nextStop = this._calcNextScheduledStopTime();
        this.forceExpiresAt = nextStop ? nextStop.timestamp : null;
        this.forceExpiresAtDesc = nextStop ? nextStop.descricao : null;
        this._save();
        console.log(`▶️  [Scheduler] Início manual ativado: ${reason}. O robô operará e pausará automaticamente no próximo horário agendado de término (${this.forceExpiresAtDesc || '05:00 SP'}).`);
        this.emit('stateChange', { allowed: true, reason });
    }

    forceStop(reason = 'Manual via painel admin') {
        this.forceState = 'stop';
        this.forceReason = reason;
        this.forceExpiresAt = null;
        this.forceExpiresAtDesc = null;
        this._save();
        console.log(`⏹  [Scheduler] Force Stop ativado: ${reason}`);
        this.emit('stateChange', { allowed: false, reason });
    }

    clearForce() {
        this.forceState = null;
        this.forceReason = null;
        this.forceExpiresAt = null;
        this.forceExpiresAtDesc = null;
        this._save();
        console.log('🔄 [Scheduler] Controle manual removido — voltando à grade padrão.');
        this.emit('stateChange', { allowed: this.isAllowedToRun(), reason: 'Grade padrão restaurada' });
    }

    // ─── Configuração da Grade ────────────────────────────────────────────────

    updateConfig(newConfig) {
        const diasValidos = (newConfig.diasSemana || []).map(Number).filter(d => d >= 0 && d <= 6);
        const rawIni = newConfig.horaInicio ?? this._config.horaInicio;
        const rawFim = newConfig.horaFim ?? this._config.horaFim;

        const iniMin = timeToMinutes(rawIni, 60);
        const fimMin = timeToMinutes(rawFim, 300);

        if (iniMin < 0 || iniMin > 1440 || fimMin < 0 || fimMin > 1440) {
            throw new Error('Horários devem ser válidos.');
        }

        const horaInicio = minutesToTimeStr(iniMin);
        const horaFim = minutesToTimeStr(fimMin);

        this._config = {
            ativo: newConfig.ativo !== undefined ? Boolean(newConfig.ativo) : this._config.ativo,
            diasSemana: diasValidos.length > 0 ? diasValidos : this._config.diasSemana,
            horaInicio,
            horaFim
        };
        this._save();
        console.log(`⚙️  [Scheduler] Configuração atualizada: ${JSON.stringify(this._config)}`);
        this.emit('configChange', this._config);
    }

    // ─── Overrides de Data ────────────────────────────────────────────────────

    setOverride(data, config) {
        if (config === false || config === null) {
            this.overrides[data] = false;
        } else {
            const rawIni = config.horaInicio;
            const rawFim = config.horaFim;
            const iniMin = timeToMinutes(rawIni, 60);
            const fimMin = timeToMinutes(rawFim, 300);
            this.overrides[data] = { 
                horaInicio: minutesToTimeStr(iniMin), 
                horaFim: minutesToTimeStr(fimMin) 
            };
        }
        this._save();
        console.log(`📅 [Scheduler] Override configurado para ${data}:`, this.overrides[data]);
    }

    removeOverride(data) {
        if (this.overrides.hasOwnProperty(data)) {
            delete this.overrides[data];
            this._save();
            console.log(`🗑️  [Scheduler] Override removido para ${data}`);
        }
    }

    // ─── Tick Automático ──────────────────────────────────────────────────────

    _startTick() {
        // Verifica a cada 60s se o estado mudou (para logar e emitir evento)
        this._schedulerTickInterval = setInterval(() => {
            const allowed = this.isAllowedToRun();
            if (this._lastAllowed !== null && this._lastAllowed !== allowed) {
                const msg = allowed
                    ? '▶️  [Scheduler] Janela de processamento aberta! Retomando downloads...'
                    : '⏹  [Scheduler] Janela de processamento encerrada. Aguardando próxima janela...';
                console.log(msg);
                this.emit('stateChange', { allowed, reason: 'Mudança automática de horário' });
            }
            this._lastAllowed = allowed;
        }, 60 * 1000);

        // Garante que o intervalo não impeça o processo de encerrar
        if (this._schedulerTickInterval.unref) this._schedulerTickInterval.unref();
    }

    stop() {
        if (this._schedulerTickInterval) {
            clearInterval(this._schedulerTickInterval);
            this._schedulerTickInterval = null;
        }
    }
}

module.exports = new SchedulerService();
