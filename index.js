const express = require("express");
const bodyParser = require("body-parser");
const dialogflow = require("@google-cloud/dialogflow");
const {
  buscarHorariosDisponiveis,
  agendarServico,
} = require("./controllers/agendamentoController");
const { encontrarOuCriarCliente } = require("./controllers/clienteController");
const pool = require("./db");

const app = express();
const port = 3000;

const sessionClient = new dialogflow.SessionsClient({
  keyFilename: "./reservai_twilio.json",
});

const projectId = "reservai-twilio-qrps";

app.use(bodyParser.urlencoded({ extended: false }));

// Função auxiliar para formatar data em padrão brasileiro
function formatarData(dia_horario) {
  const data = new Date(dia_horario);
  const dia = data.toLocaleDateString("pt-BR");
  const hora = data.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const semana = data.toLocaleDateString("pt-BR", { weekday: "long" });

  return `📅 ${
    semana.charAt(0).toUpperCase() + semana.slice(1)
  } (${dia} às ${hora})`;
}

app.post("/webhook", async (req, res) => {
  const msg = req.body.Body;
  const from = req.body.From;

  const sessionId = from;
  const sessionPath = sessionClient.projectAgentSessionPath(
    projectId,
    sessionId
  );

  const request = {
    session: sessionPath,
    queryInput: {
      text: {
        text: msg,
        languageCode: "pt-BR",
      },
    },
  };

  try {
    const responses = await sessionClient.detectIntent(request);
    const result = responses[0].queryResult;

    const intent = result.intent?.displayName;
    const parametros = result.parameters?.fields;

    console.log("Mensagem do usuário:", msg);
    console.log("Intent detectada:", intent);
    console.log("Parâmetros recebidos:", parametros);

    let resposta = "";

    switch (intent) {
      case "welcome_intent":
        resposta = result.fulfillmentText;
        break;

      case "escolha_servico":
        const servico = parametros?.servico?.stringValue;

        if (!servico) {
          resposta = "Não entendi qual serviço você deseja. Pode repetir?";
          break;
        }

        const horarios = await buscarHorariosDisponiveis();

        if (horarios.length === 0) {
          resposta = "Desculpe, não há horários disponíveis no momento.";
        } else {
          resposta = `Para *${servico}*, temos os seguintes horários disponíveis:\n\n`;
          resposta += horarios
            .map((h) => formatarData(h.dia_horario))
            .join("\n");
          resposta += `\n\nInforme o dia e hora desejados (ex: Terça 10:00).`;
        }
        break;

      case "escolha_datahora":
        const dia = parametros?.dia?.stringValue;
        const hora = parametros?.hora?.stringValue;
        const servicoNome = parametros?.servico?.stringValue;

        if (!dia || !hora || !servicoNome) {
          resposta =
            "Por favor, informe o dia e hora no formato: Segunda 14:00";
          break;
        }

        try {
          const cliente = await encontrarOuCriarCliente(from, "Cliente");

          const [servicoRow] = await pool.query(
            "SELECT id FROM servicos WHERE nome = ?",
            [servicoNome]
          );

          if (servicoRow.length === 0) {
            resposta = `Serviço "${servicoNome}" não encontrado no sistema.`;
            break;
          }

          const [horarioRow] = await pool.query(
            "SELECT id FROM horarios_disponiveis WHERE dia_semana = ? AND TIME(dia_horario) = ?",
            [dia, hora]
          );

          if (horarioRow.length === 0) {
            resposta = `Horário ${dia} às ${hora} não está disponível. Tente outro.`;
            break;
          }

          await agendarServico(cliente.id, servicoRow[0].id, horarioRow[0].id);

          resposta = `✅ Agendado! Seu *${servicoNome}* foi marcado para *${dia} às ${hora}*.`;
        } catch (err) {
          console.error("Erro ao agendar:", err);
          resposta =
            "Tivemos um erro ao tentar agendar. Tente novamente mais tarde.";
        }

        break;

      default:
        resposta = result.fulfillmentText || "Não entendi. Pode repetir?";
    }

    res.set("Content-Type", "text/xml");
    res.send(`<Response><Message>${resposta}</Message></Response>`);
  } catch (error) {
    console.error("Erro no Dialogflow:", error);
    res.set("Content-Type", "text/xml");
    res.send(
      `<Response><Message>Erro interno. Tente novamente mais tarde.</Message></Response>`
    );
  }
});

app.listen(port, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${port}`);
});
