const express = require("express");
const bodyParser = require("body-parser");
const dialogflow = require("@google-cloud/dialogflow");
const {
  buscarHorariosDisponiveis,
  agendarServico,
} = require("./controllers/agendamentoController");
const {
  encontrarOuCriarCliente,
  atualizarNomeCliente,
} = require("./controllers/clienteController");
const {
  listarAgendamentosAtivos,
  cancelarAgendamento,
  reagendarAgendamento,
} = require("./controllers/gerenciamentoController");
const pool = require("./db");

const app = express();
const port = 3000;

// Configuração do Dialogflow
const sessionClient = new dialogflow.SessionsClient({
  keyFilename: "./reservai_twilio.json", // Caminho para sua chave de serviço do Dialogflow
});
const projectId = "reservai-twilio-qrps"; // ID do seu projeto Dialogflow

// Armazena estados temporários dos agendamentos por usuário
const agendamentosPendentes = new Map();

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

/**
 * Formata um objeto Date para uma string legível em português.
 * @param {Date|string} dia_horario - O objeto Date ou string de data/hora.
 * @returns {string} Data e hora formatadas (ex: "Sexta-feira, 30/05/2025, 09:00").
 */
function formatarData(dia_horario) {
  const data = new Date(dia_horario);
  if (isNaN(data.getTime())) {
    console.error(
      "ERRO: Data inválida fornecida para formatarData:",
      dia_horario
    );
    return "Data inválida";
  }

  const options = {
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  };
  const formattedDate = new Intl.DateTimeFormat("pt-BR", options).format(data);
  // Capitaliza a primeira letra do dia da semana
  return formattedDate.charAt(0).toUpperCase() + formattedDate.slice(1);
}

/**
 * Encontra o horário disponível mais próximo a uma data/hora solicitada.
 * @param {string} horarioSolicitadoStr - String da data/hora solicitada (ISO 8601).
 * @param {Array<Object>} horariosDisponiveis - Lista de objetos de horários disponíveis.
 * @returns {Object|null} O objeto do horário mais próximo ou null se nenhum for encontrado.
 */
function encontrarHorarioProximo(horarioSolicitadoStr, horariosDisponiveis) {
  if (
    !horarioSolicitadoStr ||
    !horariosDisponiveis ||
    !horariosDisponiveis.length
  )
    return null;
  const solicitado = new Date(horarioSolicitadoStr);
  if (isNaN(solicitado.getTime())) return null;

  return horariosDisponiveis.reduce(
    (maisProximo, horario) => {
      const disponivel = new Date(horario.dia_horario);
      if (isNaN(disponivel.getTime())) return maisProximo;
      const diferenca = Math.abs(solicitado - disponivel);
      if (diferenca < maisProximo.diferenca) {
        return { horario, diferenca };
      }
      return maisProximo;
    },
    { horario: null, diferenca: Infinity }
  ).horario;
}

/**
 * Normaliza o nome de um serviço para comparação.
 * @param {string} servicoNome - Nome do serviço.
 * @returns {string} Nome do serviço em minúsculas, sem espaços.
 */
function normalizarServico(servicoNome) {
  return servicoNome.toLowerCase().replace(/\s+/g, "");
}

// Mapeamento de serviços válidos e seus IDs no banco de dados
const SERVICOS_VALIDOS = {
  corte: { id: 1, nome: "Corte" },
  cortarcabelo: { id: 1, nome: "Corte" },
  barba: { id: 2, nome: "Barba" },
  fazerbarba: { id: 2, nome: "Barba" },
  sobrancelha: { id: 3, nome: "Sobrancelha" },
  fazersobrancelha: { id: 3, nome: "Sobrancelha" },
};

/**
 * Calcula uma data futura com base no dia da semana e hora fornecidos.
 * Ajusta para a próxima semana se a data/hora já tiver passado no dia atual.
 * @param {string} diaSemanaStr - Nome do dia da semana (ex: "segunda").
 * @param {string} horaStr - Hora (ex: "10:00").
 * @returns {Date|null} Objeto Date correspondente ou null se inválido.
 */
function getDateFromWeekdayAndTime(diaSemanaStr, horaStr) {
  const diasDaSemana = [
    "domingo",
    "segunda-feira",
    "terça-feira",
    "quarta-feira",
    "quinta-feira",
    "sexta-feira",
    "sábado",
  ];
  const diaSemanaIndex = diasDaSemana.findIndex((d) =>
    d.includes(diaSemanaStr.replace("-feira", ""))
  );
  if (diaSemanaIndex === -1) return null;

  const [hora, minuto = "00"] = horaStr.split(":");
  const hoje = new Date();
  let data = new Date(hoje);

  const diferencaDias = (diaSemanaIndex - hoje.getDay() + 7) % 7;
  data.setDate(hoje.getDate() + diferencaDias);

  data.setHours(parseInt(hora, 10), parseInt(minuto, 10), 0, 0);

  // Se a data e hora calculadas já passaram hoje, avança para a próxima semana
  if (data < hoje && diferencaDias === 0) {
    data.setDate(data.getDate() + 7);
  }

  return data;
}

// --- Rota Principal do Webhook ---
app.post("/webhook", async (req, res) => {
  const msg = req.body.Body || req.body.text; // Mensagem do usuário
  const from = req.body.From || req.body.sessionId; // ID do remetente (ex: whatsapp:+5512...)
  const profileName = req.body.ProfileName || "Cliente"; // Nome do perfil do WhatsApp

  // Validação básica da requisição
  if (!msg || !from) {
    console.error("Requisição webhook inválida: 'Body' ou 'From' ausentes.");
    return res.status(400).send("Requisição inválida.");
  }

  const sessionId = from; // Usa o 'from' como ID da sessão do Dialogflow
  const sessionPath = sessionClient.projectAgentSessionPath(
    projectId,
    sessionId
  );
  const request = {
    session: sessionPath,
    queryInput: {
      text: { text: msg, languageCode: "pt-BR" },
    },
  };

  let resposta = ""; // Variável para armazenar a resposta a ser enviada ao usuário

  try {
    const [response] = await sessionClient.detectIntent(request);
    let intent = response.queryResult.intent?.displayName || "default";
    const parametros = response.queryResult.parameters?.fields || {};

    // --- Logs Detalhados para Depuração ---
    console.log("--- Nova Requisição ---");
    console.log("Mensagem do usuário:", msg);
    console.log("De:", from);

    // Encontra ou cria o cliente no banco de dados e obtém o nome mais atualizado
    // A função encontrarOuCriarCliente agora tenta persistir o profileName do Twilio
    // e prioriza o nome já salvo no DB.
    let cliente = await encontrarOuCriarCliente(from, profileName);
    console.log("Nome do Cliente (no log):", cliente.nome);

    console.log("Intent detectada pelo Dialogflow:", intent);
    console.log("Parâmetros recebidos:", JSON.stringify(parametros, null, 2));
    console.log(
      "Estado atual (agendamentosPendentes):",
      agendamentosPendentes.get(from) || "Nenhum estado"
    );

    const estadoAgendamentoPendente = agendamentosPendentes.get(from);

    // --- Lógica para forçar/ajustar a intent com base no estado atual do agendamento ---
    // Isso garante que o fluxo do bot seja mantido mesmo se o Dialogflow detectar uma intent genérica.
    if (estadoAgendamentoPendente) {
      switch (estadoAgendamentoPendente.confirmationStep) {
        case "awaiting_reagendamento_datahora":
          // Se o usuário está esperando uma data/hora para reagendar e a intent é default, força 'escolha_datahora_reagendamento'
          if (intent === "default") {
            intent = "escolha_datahora_reagendamento";
          }
          break;
        case "awaiting_name_choice":
          // Se o usuário está escolhendo manter ou trocar o nome
          const msgLower = msg.toLowerCase().trim();
          if (
            ["sim", "manter", "confirmar", "pode agendar", "agendar"].some(
              (k) => msgLower.includes(k)
            )
          ) {
            intent = "confirmar_agendamento_com_nome";
          } else if (
            ["não", "trocar", "outro"].some((k) => msgLower.includes(k))
          ) {
            intent = "pedir_novo_nome";
          }
          break;
        case "awaiting_new_name":
          // Se o bot está esperando um novo nome, qualquer mensagem é tratada como 'salvar_novo_nome'
          intent = "salvar_novo_nome";
          break;
        case "confirmar_inicio_reagendamento":
          // Confirmação para iniciar o reagendamento de um agendamento único
          if (
            ["sim", "confirmar", "quero continuar"].some((k) =>
              msgLower.includes(k)
            )
          ) {
            intent = "confirmar_inicio_reagendamento";
          }
          break;
        case "awaiting_reagendamento_confirmation":
          // Confirmação final do reagendamento
          if (["sim", "confirmar"].some((k) => msgLower.includes(k))) {
            intent = "confirmar_reagendamento";
          } else if (["não", "cancelar"].some((k) => msgLower.includes(k))) {
            resposta =
              "Reagendamento cancelado. Deseja escolher outro horário?";
            // Volta para a etapa de escolha de horário para reagendamento, caso o usuário mude de ideia
            estadoAgendamentoPendente.confirmationStep =
              "awaiting_reagendamento_datahora";
            agendamentosPendentes.set(from, estadoAgendamentoPendente);
            res.json({ reply: resposta });
            return; // Encerra a execução após enviar a resposta
          }
          break;
        case "confirmar_horario_proximo":
          // Confirmação de um horário alternativo sugerido
          if (["sim", "confirmar"].some((k) => msgLower.includes(k))) {
            intent = "confirmar_horario_proximo";
          }
          break;
        case "confirmar_cancelamento":
          // Confirmação final do cancelamento
          if (["sim", "confirmar"].some((k) => msgLower.includes(k))) {
            intent = "confirmar_cancelamento";
          } else if (["não", "cancelar"].some((k) => msgLower.includes(k))) {
            resposta = "Cancelamento não confirmado. Deseja fazer algo mais?";
            agendamentosPendentes.delete(from); // Limpa o estado de cancelamento
            res.json({ reply: resposta });
            return; // Encerra a execução
          }
          break;
      }
    }

    // --- Processamento da Intent Detectada ---
    switch (intent) {
      case "welcome_intent":
        resposta =
          "Opa, seja bem-vindo à Barbearia!\nQual serviço deseja agendar? (Corte, Barba, ou Sobrancelha)";
        agendamentosPendentes.delete(from); // Garante que nenhum estado antigo atrapalhe
        break;

      case "escolha_servico": {
        const servicoNome = parametros?.servico?.stringValue;
        if (!servicoNome) {
          resposta =
            "Não entendi qual serviço você deseja. Escolha entre Corte, Barba ou Sobrancelha.";
          agendamentosPendentes.delete(from);
          break;
        }

        const servicoNormalizado = normalizarServico(servicoNome);
        const servicoInfo = SERVICOS_VALIDOS[servicoNormalizado];

        if (!servicoInfo) {
          resposta = `Desculpe, o serviço "${servicoNome}" não foi reconhecido. Escolha entre Corte, Barba ou Sobrancelha.`;
          agendamentosPendentes.delete(from);
          break;
        }

        let agendamentoPendente = agendamentosPendentes.get(from) || {
          servicos: [],
          servicoIds: [],
          confirmationStep: "initial",
        };

        // Adiciona o serviço escolhido (evita duplicatas se o usuário repetir)
        if (!agendamentoPendente.servicos.includes(servicoInfo.nome)) {
          agendamentoPendente.servicos.push(servicoInfo.nome);
          // Garante que servicoIds seja um array e adiciona o ID
          agendamentoPendente.servicoIds = Array.isArray(
            agendamentoPendente.servicoIds
          )
            ? agendamentoPendente.servicoIds
            : [];
          agendamentoPendente.servicoIds.push(servicoInfo.id);
        }

        const horarios = await buscarHorariosDisponiveis();
        // Verifica se há horários ou se a busca falhou
        if (!horarios || !horarios.length) {
          resposta =
            "Não temos horários disponíveis no momento. Tente novamente mais tarde!";
          agendamentosPendentes.delete(from);
          break;
        }

        resposta = `Ótimo! Você escolheu *${agendamentoPendente.servicos.join(
          " e "
        )}*. Horários disponíveis:\n\n${horarios
          .map((h, index) => `${index + 1}. *${formatarData(h.dia_horario)}*`)
          .join(
            "\n"
          )}\n\nDigite o número do horário desejado ou informe um dia e horário (exemplo: Sexta 10:00).`;
        agendamentoPendente.confirmationStep = "awaiting_date_time";
        agendamentosPendentes.set(from, agendamentoPendente);
        break;
      }

      case "escolha_datahora": {
        const agendamentoPendente = agendamentosPendentes.get(from);
        // Valida se há um agendamento em andamento e serviços selecionados
        if (
          !agendamentoPendente ||
          !agendamentoPendente.servicos.length ||
          !Array.isArray(agendamentoPendente.servicoIds) ||
          !agendamentoPendente.servicoIds.length
        ) {
          resposta =
            "Escolha um serviço antes (Corte, Barba ou Sobrancelha). Qual prefere?";
          agendamentosPendentes.delete(from);
          break;
        }

        const horarios = await buscarHorariosDisponiveis();
        if (!horarios || !horarios.length) {
          resposta =
            "Não temos horários disponíveis no momento. Tente novamente mais tarde!";
          agendamentosPendentes.delete(from);
          break;
        }

        let horarioId, diaHorario;
        const escolhaNumero = parseInt(msg) - 1; // Ajusta para índice 0
        let dataSolicitada = null;

        if (!isNaN(escolhaNumero) && horarios[escolhaNumero]) {
          // Usuário escolheu por número
          horarioId = horarios[escolhaNumero].id;
          diaHorario = horarios[escolhaNumero].dia_horario;
        } else {
          // Usuário tentou informar dia e hora
          const diaSemanaMatch = msg
            .toLowerCase()
            .match(/(segunda|terça|quarta|quinta|sexta|sábado|domingo)/);
          const horaMatch = msg.match(
            /\d{1,2}(?::\d{2})?(?:\s*(?:h|horas?|às))?/i
          );

          if (diaSemanaMatch && horaMatch) {
            dataSolicitada = getDateFromWeekdayAndTime(
              diaSemanaMatch[0],
              horaMatch[0].replace(/h|horas?|às/i, "").trim()
            );
          } else if (parametros?.["date-time"]?.stringValue) {
            // Se o Dialogflow detectou um @sys.date-time
            dataSolicitada = new Date(parametros["date-time"].stringValue);
          } else if (msg.match(/\d{1,2}:\d{2}/)) {
            // Se o usuário digitou apenas um horário (ex: "10:00")
            const [hora, minuto = "00"] = msg
              .match(/\d{1,2}:\d{2}/)[0]
              .split(":");
            dataSolicitada = new Date();
            dataSolicitada.setHours(
              parseInt(hora, 10),
              parseInt(minuto, 10),
              0,
              0
            );
            // Se o horário já passou hoje, sugere para o dia seguinte
            if (dataSolicitada < new Date()) {
              dataSolicitada.setDate(dataSolicitada.getDate() + 1);
            }
          }

          if (dataSolicitada && !isNaN(dataSolicitada.getTime())) {
            const diaDaSemanaFormatado = dataSolicitada
              .toLocaleDateString("pt-BR", { weekday: "long" })
              .toLowerCase();
            const horaFormatada = dataSolicitada.toLocaleTimeString("pt-BR", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            });

            // Busca por horário exato no banco de dados
            const [horarioRow] = await pool.query(
              `SELECT id, dia_horario
               FROM horarios_disponiveis
               WHERE LOWER(dia_semana) = ?
               AND DATE_FORMAT(dia_horario, '%H:%i') = ?
               AND disponivel = TRUE
               AND dia_horario >= NOW()
               LIMIT 1`,
              [diaDaSemanaFormatado, horaFormatada]
            );

            if (horarioRow.length) {
              horarioId = horarioRow[0].id;
              diaHorario = horarioRow[0].dia_horario;
            } else {
              // Se o horário exato não for encontrado, procura o mais próximo
              const horarioMaisProximo = encontrarHorarioProximo(
                dataSolicitada.toISOString(),
                horarios
              );
              if (horarioMaisProximo) {
                resposta = `O horário *${diaDaSemanaFormatado} às ${horaFormatada}* não está disponível. O mais próximo é *${formatarData(
                  horarioMaisProximo.dia_horario
                )}*. Deseja escolher este? Responda 'Sim' ou escolha outro horário.`;
                // Armazena o horário próximo para confirmação futura
                agendamentosPendentes.set(from, {
                  ...agendamentoPendente,
                  confirmationStep: "confirmar_horario_proximo",
                  horarioProximoId: horarioMaisProximo.id,
                  diaHorarioProximo: horarioMaisProximo.dia_horario,
                });
                break; // Sai do switch case, aguardando a confirmação do horário próximo
              } else {
                resposta = `Nenhum horário disponível próximo a *${diaDaSemanaFormatado} às ${horaFormatada}*. Escolha outro:\n\n${horarios
                  .map(
                    (h, index) =>
                      `${index + 1}. *${formatarData(h.dia_horario)}*`
                  )
                  .join("\n")}\n\nOu use o formato 'Sexta 10:00'.`;
                break;
              }
            }
          } else {
            resposta = `Formato inválido. Por favor, escolha um número da lista ou informe um dia e horário (exemplo: Sexta 10:00).\n\nHorários disponíveis:\n\n${horarios
              .map(
                (h, index) => `${index + 1}. *${formatarData(h.dia_horario)}*`
              )
              .join("\n")}`;
            break;
          }
        }

        // Se um horário válido foi escolhido/encontrado, atualiza o estado
        agendamentoPendente.horarioId = horarioId;
        agendamentoPendente.dia_horario = diaHorario;

        // O objeto 'cliente' já está atualizado no início do webhook
        agendamentoPendente.clienteId = cliente.id;
        agendamentoPendente.nomeSugerido = cliente.nome;

        agendamentoPendente.confirmationStep = "awaiting_name_choice";
        agendamentosPendentes.set(from, agendamentoPendente);

        const horarioFormatado = formatarData(diaHorario);
        resposta = `Você escolheu *${agendamentoPendente.servicos.join(
          " e "
        )}* para *${horarioFormatado}*. O nome que usaremos para o agendamento é *${
          cliente.nome
        }* e o telefone *${
          cliente.telefone
        }*. Gostaria de manter este nome ou informar outro? (Responda 'Manter' ou 'Trocar')`;
        break;
      }

      case "confirmar_agendamento_com_nome": {
        const agendamentoPendente = agendamentosPendentes.get(from);
        if (
          !agendamentoPendente ||
          (agendamentoPendente.confirmationStep !== "awaiting_name_choice" &&
            agendamentoPendente.confirmationStep !==
              "awaiting_new_name_confirmation") // Permite confirmar após digitar um novo nome
        ) {
          resposta =
            "Nenhum agendamento em andamento ou etapa incorreta. Quer agendar um serviço?";
          agendamentosPendentes.delete(from);
          break;
        }

        // A variável 'cliente' no escopo global do webhook já possui o nome correto.
        const result = await agendarServico(
          agendamentoPendente.clienteId,
          agendamentoPendente.horarioId,
          agendamentoPendente.servicoIds
        );

        if (!result.success) {
          resposta =
            result.message ||
            "Ops, algo deu errado ao agendar. Tente novamente.";
          agendamentosPendentes.delete(from);
          break;
        }

        const horarioFormatado = formatarData(agendamentoPendente.dia_horario);
        resposta = `✅ Agendamento confirmado para *${agendamentoPendente.servicos.join(
          " e "
        )}* em *${horarioFormatado}*, no nome de *${cliente.nome}*!`; // Usa o nome atualizado do cliente
        agendamentosPendentes.delete(from);
        break;
      }

      case "pedir_novo_nome": {
        const agendamentoPendente = agendamentosPendentes.get(from);
        if (
          !agendamentoPendente ||
          agendamentoPendente.confirmationStep !== "awaiting_name_choice"
        ) {
          resposta =
            "Não estou esperando um nome agora. Por favor, comece o agendamento novamente.";
          agendamentosPendentes.delete(from);
          break;
        }
        resposta =
          "Ok, por favor, me diga o nome que você gostaria de usar para o agendamento.";
        agendamentosPendentes.set(from, {
          ...agendamentoPendente,
          confirmationStep: "awaiting_new_name",
        });
        break;
      }

      case "salvar_novo_nome": {
        const agendamentoPendente = agendamentosPendentes.get(from);
        if (
          !agendamentoPendente ||
          agendamentoPendente.confirmationStep !== "awaiting_new_name"
        ) {
          resposta =
            "Não estou esperando um nome agora. Por favor, comece o agendamento novamente.";
          agendamentosPendentes.delete(from);
          break;
        }

        const novoNome = msg.trim();
        if (novoNome.length < 2) {
          resposta =
            "Por favor, me diga um nome válido (com pelo menos 2 caracteres).";
          break;
        }

        const clienteAtualizado = await atualizarNomeCliente(
          agendamentoPendente.clienteId,
          novoNome
        );

        if (clienteAtualizado) {
          // ATUALIZA o objeto 'cliente' global na requisição com o nome recém-salvo
          cliente = clienteAtualizado;

          agendamentoPendente.nomeSugerido = novoNome;
          const horarioFormatado = formatarData(
            agendamentoPendente.dia_horario
          );
          resposta = `Nome atualizado para *${novoNome}*. Confirma o agendamento de *${agendamentoPendente.servicos.join(
            " e "
          )}* para *${horarioFormatado}* com o telefone *${
            cliente.telefone
          }*? (Responda 'Sim' ou 'Não')`;
          agendamentosPendentes.set(from, {
            ...agendamentoPendente,
            confirmationStep: "awaiting_name_choice", // Volta para a etapa de escolha para confirmar o agendamento com o novo nome
          });
        } else {
          resposta =
            "Não consegui atualizar seu nome. Por favor, tente novamente.";
        }
        break;
      }

      case "reagendar_agendamento": {
        // Cliente já foi obtido no início do webhook.
        let agendamentosAtivos;
        try {
          agendamentosAtivos = await listarAgendamentosAtivos(cliente.id);
        } catch (error) {
          console.error(
            "ERRO: Erro ao listar agendamentos para reagendamento:",
            error
          );
          resposta =
            "Ops, não conseguimos verificar seus agendamentos. Tente novamente mais tarde.";
          agendamentosPendentes.delete(from);
          break;
        }

        if (!agendamentosAtivos.length) {
          resposta = "Você não tem agendamentos ativos para reagendar.";
          agendamentosPendentes.delete(from);
          break;
        }

        if (agendamentosAtivos.length === 1) {
          const agendamento = agendamentosAtivos[0];
          const horarioFormatado = formatarData(agendamento.dia_horario);
          resposta = `Você tem um agendamento para *${agendamento.servico}* em *${horarioFormatado}*. Deseja reagendar? Responda 'Sim' ou 'Não'.`;
          agendamentosPendentes.set(from, {
            clienteId: cliente.id,
            agendamentoId: agendamento.id,
            servico: agendamento.servico,
            confirmationStep: "confirmar_inicio_reagendamento",
          });
        } else {
          resposta = `Você tem ${agendamentosAtivos.length} agendamentos ativos. Qual deseja reagendar?\n\n`;
          agendamentosAtivos.forEach((agendamento, index) => {
            const horarioFormatado = formatarData(agendamento.dia_horario);
            resposta += `${index + 1}. *${
              agendamento.servico
            }* em *${horarioFormatado}*\n`;
          });
          resposta += `\nDigite o número do agendamento (exemplo: 1).`;
          agendamentosPendentes.set(from, {
            clienteId: cliente.id,
            agendamentosAtivos,
            confirmationStep: "selecionar_reagendamento",
          });
        }
        break;
      }

      case "selecionar_reagendamento": {
        const agendamentoPendente = agendamentosPendentes.get(from);
        if (
          !agendamentoPendente ||
          agendamentoPendente.confirmationStep !== "selecionar_reagendamento" ||
          !agendamentoPendente.agendamentosAtivos
        ) {
          resposta =
            "Nenhum reagendamento em andamento. Quer reagendar um agendamento?";
          agendamentosPendentes.delete(from);
          break;
        }

        const escolhaNumero = parseInt(msg) - 1;
        const agendamentoEscolhido =
          agendamentoPendente.agendamentosAtivos[escolhaNumero];

        if (!isNaN(escolhaNumero) && agendamentoEscolhido) {
          const horarios = await buscarHorariosDisponiveis();
          if (!horarios || !horarios.length) {
            resposta =
              "Não temos horários disponíveis no momento. Tente novamente mais tarde!";
            agendamentosPendentes.delete(from);
            break;
          }

          resposta = `Beleza! Você escolheu reagendar o agendamento de *${
            agendamentoEscolhido.servico
          }* em *${formatarData(
            agendamentoEscolhido.dia_horario
          )}*. Escolha um novo horário:\n\n${horarios
            .map((h, index) => `${index + 1}. *${formatarData(h.dia_horario)}*`)
            .join(
              "\n"
            )}\n\nDigite o número do horário ou informe um dia e horário (exemplo: Sexta 10:00).`;

          agendamentosPendentes.set(from, {
            ...agendamentoPendente,
            agendamentoId: agendamentoEscolhido.id,
            servico: agendamentoEscolhido.servico,
            confirmationStep: "awaiting_reagendamento_datahora",
            agendamentosAtivos: undefined, // Limpa agendamentosAtivos para evitar uso incorreto
          });
        } else {
          resposta = `Escolha um número válido do agendamento que deseja reagendar.`;
        }
        break;
      }

      case "confirmar_inicio_reagendamento": {
        const agendamentoPendente = agendamentosPendentes.get(from);
        if (
          !agendamentoPendente ||
          agendamentoPendente.confirmationStep !==
            "confirmar_inicio_reagendamento"
        ) {
          resposta =
            "Nenhum reagendamento em andamento. Quer reagendar um agendamento?";
          agendamentosPendentes.delete(from);
          break;
        }

        const isConfirmation = ["sim", "confirmar", "quero continuar"].some(
          (k) => msg.toLowerCase().includes(k)
        );

        if (isConfirmation) {
          const horarios = await buscarHorariosDisponiveis();
          if (!horarios || !horarios.length) {
            resposta =
              "Não temos horários disponíveis no momento. Tente novamente mais tarde!";
            agendamentosPendentes.delete(from);
            break;
          }

          resposta = `Beleza! Escolha um novo horário:\n\n${horarios
            .map((h, index) => `${index + 1}. *${formatarData(h.dia_horario)}*`)
            .join(
              "\n"
            )}\n\nDigite o número do horário ou informe um dia e horário (exemplo: Sexta 10:00).`;
          agendamentoPendente.confirmationStep =
            "awaiting_reagendamento_datahora";
          agendamentosPendentes.set(from, agendamentoPendente);
        } else {
          resposta = "Reagendamento cancelado. Deseja fazer algo mais?";
          agendamentosPendentes.delete(from);
        }
        break;
      }

      case "escolha_datahora_reagendamento": {
        const agendamentoPendente = agendamentosPendentes.get(from);
        if (
          !agendamentoPendente ||
          agendamentoPendente.confirmationStep !==
            "awaiting_reagendamento_datahora"
        ) {
          resposta =
            "Nenhum reagendamento em andamento. Quer reagendar um agendamento?";
          agendamentosPendentes.delete(from);
          break;
        }

        const horarios = await buscarHorariosDisponiveis();
        if (!horarios || !horarios.length) {
          resposta =
            "Não temos horários disponíveis no momento. Tente novamente mais tarde!";
          agendamentosPendentes.delete(from);
          break;
        }

        let horarioId, diaHorario;
        const escolhaNumero = parseInt(msg) - 1;
        let dataSolicitada = null;

        if (!isNaN(escolhaNumero) && horarios[escolhaNumero]) {
          horarioId = horarios[escolhaNumero].id;
          diaHorario = horarios[escolhaNumero].dia_horario;
        } else {
          const diaSemanaMatch = msg
            .toLowerCase()
            .match(/(segunda|terça|quarta|quinta|sexta|sábado|domingo)/);
          const horaMatch = msg.match(
            /\d{1,2}(?::\d{2})?(?:\s*(?:h|horas?|às))?/i
          );
          const diaSemanaParam =
            parametros?.dia_semana?.stringValue?.toLowerCase();

          if ((diaSemanaMatch || diaSemanaParam) && horaMatch) {
            const diaSemanaForParse = diaSemanaParam || diaSemanaMatch[0];
            dataSolicitada = getDateFromWeekdayAndTime(
              diaSemanaForParse,
              horaMatch[0].replace(/h|horas?|às/i, "").trim()
            );
          } else if (parametros?.["date-time"]?.stringValue) {
            dataSolicitada = new Date(parametros["date-time"].stringValue);
          } else if (msg.match(/\d{1,2}:\d{2}/)) {
            const [hora, minuto = "00"] = msg
              .match(/\d{1,2}:\d{2}/)[0]
              .split(":");
            dataSolicitada = new Date();
            dataSolicitada.setHours(
              parseInt(hora, 10),
              parseInt(minuto, 10),
              0,
              0
            );
            if (dataSolicitada < new Date()) {
              dataSolicitada.setDate(dataSolicitada.getDate() + 1);
            }
          }

          if (dataSolicitada && !isNaN(dataSolicitada.getTime())) {
            const diaDaSemanaFormatado = dataSolicitada
              .toLocaleDateString("pt-BR", { weekday: "long" })
              .toLowerCase();
            const horaFormatada = dataSolicitada.toLocaleTimeString("pt-BR", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            });

            const [horarioRow] = await pool.query(
              `SELECT id, dia_horario
               FROM horarios_disponiveis
               WHERE LOWER(dia_semana) = ?
               AND DATE_FORMAT(dia_horario, '%H:%i') = ?
               AND disponivel = TRUE
               AND dia_horario >= NOW()
               LIMIT 1`,
              [diaDaSemanaFormatado, horaFormatada]
            );

            if (horarioRow.length) {
              horarioId = horarioRow[0].id;
              diaHorario = horarioRow[0].dia_horario;
            } else {
              const horarioMaisProximo = encontrarHorarioProximo(
                dataSolicitada.toISOString(),
                horarios
              );
              if (horarioMaisProximo) {
                resposta = `O horário *${diaDaSemanaFormatado} às ${horaFormatada}* não está disponível. O mais próximo é *${formatarData(
                  horarioMaisProximo.dia_horario
                )}*. Deseja escolher este? Responda 'Sim' ou escolha outro horário.`;
                agendamentosPendentes.set(from, {
                  ...agendamentoPendente,
                  confirmationStep: "confirmar_horario_proximo",
                  horarioProximoId: horarioMaisProximo.id,
                  diaHorarioProximo: horarioMaisProximo.dia_horario,
                });
                break;
              } else {
                resposta = `Nenhum horário disponível próximo a *${diaDaSemanaFormatado} às ${horaFormatada}*. Escolha outro:\n\n${horarios
                  .map(
                    (h, index) =>
                      `${index + 1}. *${formatarData(h.dia_horario)}*`
                  )
                  .join("\n")}\n\nOu use o formato 'Sexta 10:00'.`;
                break;
              }
            }
          } else {
            resposta = `Formato inválido. Escolha um horário da lista:\n\n${horarios
              .map(
                (h, index) => `${index + 1}. *${formatarData(h.dia_horario)}*`
              )
              .join("\n")}\n\nOu use o formato 'Sexta 10:00'.`;
            break;
          }
        }

        agendamentoPendente.horarioId = horarioId;
        agendamentoPendente.dia_horario = diaHorario;
        agendamentoPendente.confirmationStep =
          "awaiting_reagendamento_confirmation";
        agendamentosPendentes.set(from, agendamentoPendente);

        const horarioFormatado = formatarData(diaHorario);
        resposta = `Você escolheu reagendar *${agendamentoPendente.servico}* para *${horarioFormatado}*. Confirma? Responda 'Sim' ou 'Não'.`;
        break;
      }

      case "confirmar_reagendamento": {
        const agendamentoPendente = agendamentosPendentes.get(from);
        if (
          !agendamentoPendente ||
          agendamentoPendente.confirmationStep !==
            "awaiting_reagendamento_confirmation"
        ) {
          resposta =
            "Nenhum reagendamento em andamento. Quer reagendar um agendamento?";
          agendamentosPendentes.delete(from);
          break;
        }

        const isConfirmation = ["sim", "confirmar"].some((k) =>
          msg.toLowerCase().includes(k)
        );

        if (isConfirmation) {
          const result = await reagendarAgendamento(
            agendamentoPendente.agendamentoId,
            agendamentoPendente.horarioId
          );

          if (!result.success) {
            resposta =
              result.message ||
              "Ops, algo deu errado ao reagendar. Tente novamente.";
            agendamentosPendentes.delete(from);
            break;
          }

          const horarioFormatado = formatarData(
            agendamentoPendente.dia_horario
          );
          resposta = `✅ Agendamento reagendado para *${agendamentoPendente.servico}* em *${horarioFormatado}*!`;
          agendamentosPendentes.delete(from);
        } else {
          resposta = "Reagendamento cancelado. Deseja escolher outro horário?";
          agendamentoPendente.confirmationStep =
            "awaiting_reagendamento_datahora"; // Permite que o usuário escolha outro horário imediatamente
          agendamentosPendentes.set(from, agendamentoPendente);
        }
        break;
      }

      case "confirmar_horario_proximo": {
        const agendamentoPendente = agendamentosPendentes.get(from);
        if (
          !agendamentoPendente ||
          agendamentoPendente.confirmationStep !==
            "confirmar_horario_proximo" ||
          !agendamentoPendente.horarioProximoId
        ) {
          resposta =
            "Nenhuma sugestão de horário próximo para confirmar. Por favor, tente novamente.";
          agendamentosPendentes.delete(from);
          break;
        }

        const isConfirmation = ["sim", "confirmar"].some((k) =>
          msg.toLowerCase().includes(k)
        );

        if (isConfirmation) {
          agendamentoPendente.horarioId = agendamentoPendente.horarioProximoId;
          agendamentoPendente.dia_horario =
            agendamentoPendente.diaHorarioProximo;

          if (agendamentoPendente.agendamentoId) {
            // Se for um reagendamento
            agendamentoPendente.confirmationStep =
              "awaiting_reagendamento_confirmation";
            const horarioFormatado = formatarData(
              agendamentoPendente.dia_horario
            );
            resposta = `Você escolheu reagendar *${agendamentoPendente.servico}* para *${horarioFormatado}*. Confirma? Responda 'Sim' ou 'Não'.`;
          } else {
            // Se for um novo agendamento
            agendamentoPendente.confirmationStep = "awaiting_name_choice";
            // 'cliente' já está no escopo global do webhook com os dados atualizados
            agendamentoPendente.clienteId = cliente.id;
            agendamentoPendente.nomeSugerido = cliente.nome;
            const horarioFormatado = formatarData(
              agendamentoPendente.dia_horario
            );
            resposta = `Você escolheu *${agendamentoPendente.servicos.join(
              " e "
            )}* para *${horarioFormatado}*. O nome que usaremos para o agendamento é *${
              cliente.nome
            }* e o telefone *${
              cliente.telefone
            }*. Gostaria de manter este nome ou informar outro? (Responda 'Manter' ou 'Trocar')`;
          }
          agendamentosPendentes.set(from, agendamentoPendente);
        } else {
          // Se o usuário não quiser o horário próximo, oferece a lista novamente
          const horarios = await buscarHorariosDisponiveis();
          resposta = `Ok, escolha outro horário:\n\n${horarios
            .map((h, index) => `${index + 1}. *${formatarData(h.dia_horario)}*`)
            .join("\n")}\n\nOu use o formato 'Sexta 10:00'.`;

          agendamentoPendente.confirmationStep =
            agendamentoPendente.agendamentoId
              ? "awaiting_reagendamento_datahora" // Volta para escolha de horário para reagendamento
              : "awaiting_date_time"; // Volta para escolha de horário para novo agendamento
          delete agendamentoPendente.horarioProximoId; // Limpa os dados do horário sugerido
          delete agendamentoPendente.diaHorarioProximo;
          agendamentosPendentes.set(from, agendamentoPendente);
        }
        break;
      }

      case "cancelar_agendamento": {
        // 'cliente' já está no escopo global do webhook com os dados atualizados
        let agendamentosAtivos;
        try {
          agendamentosAtivos = await listarAgendamentosAtivos(cliente.id);
        } catch (error) {
          console.error(
            "ERRO: Erro ao listar agendamentos para cancelamento:",
            error
          );
          resposta =
            "Ops, não conseguimos verificar seus agendamentos. Tente novamente mais tarde.";
          agendamentosPendentes.delete(from);
          break;
        }

        if (!agendamentosAtivos.length) {
          resposta = "Você não tem agendamentos ativos para cancelar.";
          agendamentosPendentes.delete(from);
          break;
        }

        if (agendamentosAtivos.length === 1) {
          const agendamento = agendamentosAtivos[0];
          const horarioFormatado = formatarData(agendamento.dia_horario);
          resposta = `Você tem um agendamento para *${agendamento.servico}* em *${horarioFormatado}*. Deseja cancelar? Responda 'Sim' ou 'Não'.`;
          agendamentosPendentes.set(from, {
            clienteId: cliente.id,
            agendamentoId: agendamento.id,
            servico: agendamento.servico,
            confirmationStep: "confirmar_cancelamento",
          });
        } else {
          resposta = `Você tem ${agendamentosAtivos.length} agendamentos ativos. Qual deseja cancelar?\n\n`;
          agendamentosAtivos.forEach((agendamento, index) => {
            const horarioFormatado = formatarData(agendamento.dia_horario);
            resposta += `${index + 1}. *${
              agendamento.servico
            }* em *${horarioFormatado}*\n`;
          });
          resposta += `\nDigite o número do agendamento (exemplo: 1).`;
          agendamentosPendentes.set(from, {
            clienteId: cliente.id,
            agendamentosAtivos,
            confirmationStep: "selecionar_cancelamento",
          });
        }
        break;
      }

      case "selecionar_cancelamento": {
        const agendamentoPendente = agendamentosPendentes.get(from);
        if (
          !agendamentoPendente ||
          agendamentoPendente.confirmationStep !== "selecionar_cancelamento" ||
          !agendamentoPendente.agendamentosAtivos
        ) {
          resposta =
            "Nenhum cancelamento em andamento. Quer cancelar um agendamento?";
          agendamentosPendentes.delete(from);
          break;
        }

        const escolhaNumero = parseInt(msg) - 1;
        const agendamentoEscolhido =
          agendamentoPendente.agendamentosAtivos[escolhaNumero];

        if (!isNaN(escolhaNumero) && agendamentoEscolhido) {
          const horarioFormatado = formatarData(
            agendamentoEscolhido.dia_horario
          );
          resposta = `Você escolheu cancelar o agendamento de *${agendamentoEscolhido.servico}* em *${horarioFormatado}*. Confirma o cancelamento? Responda 'Sim' ou 'Não'.`;
          agendamentosPendentes.set(from, {
            ...agendamentoPendente,
            agendamentoId: agendamentoEscolhido.id,
            servico: agendamentoEscolhido.servico,
            confirmationStep: "confirmar_cancelamento",
            agendamentosAtivos: undefined, // Limpa agendamentosAtivos
          });
        } else {
          resposta = `Escolha um número válido do agendamento que deseja cancelar.`;
        }
        break;
      }

      case "confirmar_cancelamento": {
        const agendamentoPendente = agendamentosPendentes.get(from);
        if (
          !agendamentoPendente ||
          agendamentoPendente.confirmationStep !== "confirmar_cancelamento"
        ) {
          resposta =
            "Nenhum cancelamento em andamento. Quer cancelar um agendamento?";
          agendamentosPendentes.delete(from);
          break;
        }

        const isConfirmation = ["sim", "confirmar"].some((k) =>
          msg.toLowerCase().includes(k)
        );

        if (isConfirmation) {
          const result = await cancelarAgendamento(
            agendamentoPendente.agendamentoId
          );

          if (!result.success) {
            resposta =
              result.message ||
              "Ops, algo deu errado ao cancelar o agendamento. Por favor, tente novamente.";
            resposta +=
              "\nSe o problema persistir, entre em contato conosco diretamente para obter ajuda.";
            agendamentosPendentes.delete(from);
            break;
          }

          resposta = `✅ Agendamento de *${agendamentoPendente.servico}* cancelado com sucesso!`;
          agendamentosPendentes.delete(from);
        } else {
          resposta = "Cancelamento não confirmado. Deseja fazer algo mais?";
          agendamentosPendentes.delete(from);
        }
        break;
      }

      // Tratamento para a intent 'confirmar_agendamento' (caso seja detectada de forma inesperada)
      case "confirmar_agendamento":
        resposta =
          "Desculpe, não entendi o que você quer confirmar. Por favor, comece o agendamento novamente.";
        agendamentosPendentes.delete(from);
        break;

      default:
        // Se a intent for 'default' do Dialogflow e não houver um estado ativo,
        // ou se o estado não foi tratado pelas lógicas acima, usa o fulfillmentText ou uma mensagem genérica.
        resposta =
          response.queryResult.fulfillmentText ||
          "Desculpe, não entendi. Pode repetir, por favor?";
        if (!estadoAgendamentoPendente) {
          // Limpa o estado se não houver um fluxo ativo
          agendamentosPendentes.delete(from);
        }
        break;
    }

    console.log("Resposta FINAL a ser enviada ao usuário:", resposta);
    res.json({ reply: resposta });
  } catch (error) {
    // Captura erros globais do webhook
    console.error("ERRO GERAL no Dialogflow ou webhook:", error);
    res.json({ reply: "Ops, algo deu errado. Tente novamente?" });
  }
});

app.listen(port, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${port}`);
});
