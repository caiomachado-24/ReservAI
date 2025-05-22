const express = require("express");
const bodyParser = require("body-parser");
const dialogflow = require("@google-cloud/dialogflow");
const uuid = require("uuid");
const projectId = "reservai-twilio-qrps";
const sessionClient = new dialogflow.SessionsClient({
  keyFilename: "./reservai_twilio.json",
});

const app = express();
const port = 3000;

app.use(bodyParser.urlencoded({ extended: false }));

app.post("/webhook", async (req, res) => {
  const msg = req.body.Body;
  const from = req.body.From;
  const sessionId = uuid.v4();

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

  const responses = await sessionClient.detectIntent(request);
  const result = responses[0].queryResult;

  res.set("Content-Type", "text/xml");
  res.send(`
    <Response>
      <Message>${result.fulfillmentText}</Message>
    </Response>
  `);
});

app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});
