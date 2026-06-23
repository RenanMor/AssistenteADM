const express = require('express');
const { GoogleGenAI } = require('@google/genai');
const { google } = require('googleapis');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

const MODELOS_GEMINI = [
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.0-flash'
];

async function chamarGeminiComRetry(ai, prompt, tentativas = 5) {

    let ultimoErro;

    for (const modelo of MODELOS_GEMINI) {

        for (let i = 0; i < tentativas; i++) {

            try {

                console.log(`🔍 Tentando modelo: ${modelo}`);

                const resposta = await ai.models.generateContent({
                    model: modelo,
                    contents: prompt
                });

                console.log(`✅ Modelo ativo: ${modelo}`);

                return resposta;

            } catch (erro) {

                ultimoErro = erro;

                console.warn(
                    `⚠️ Modelo ${modelo} - tentativa ${i + 1} falhou:`,
                    erro.message
                );

                if (
                    erro.message &&
                    (
                        erro.message.includes('404') ||
                        erro.message.includes('NOT_FOUND')
                    )
                ) {
                    break;
                }

                if (i < tentativas - 1) {
                    await new Promise(resolve =>
                        setTimeout(resolve, 2000 * (i + 1))
                    );
                }
            }
        }
    }

    throw ultimoErro;
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/gemini-workspace', async (req, res) => {

    try {

        const { pergunta } = req.body;

        if (!pergunta) {
            return res.status(400).json({
                resultado: 'Pergunta ausente.'
            });
        }

        const credenciaisGoogle =
            process.env.GOOGLE_CREDENTIALS;

        const pastaId =
            process.env.GOOGLE_DRIVE_FOLDER_ID;

        const chaveGemini =
            process.env.GEMINI_API_KEY;

        if (
            !credenciaisGoogle ||
            !pastaId ||
            !chaveGemini
        ) {
            return res.status(500).json({
                resultado:
                    'Erro: Variáveis de ambiente faltando no Render.'
            });
        }

        const auth = new google.auth.GoogleAuth({
            credentials: JSON.parse(credenciaisGoogle),
            scopes: [
                'https://www.googleapis.com/auth/drive.readonly'
            ]
        });

        const drive = google.drive({
            version: 'v3',
            auth
        });

        const listaDrive = await drive.files.list({
            q: `'${pastaId}' in parents and mimeType='application/pdf' and trashed=false`,
            fields: 'files(id,name,webViewLink)'
        });

        const ficheiros = listaDrive.data.files;

        if (!ficheiros || ficheiros.length === 0) {
            return res.json({
                resultado:
                    'Nenhum PDF encontrado na pasta.'
            });
        }

        const ai = new GoogleGenAI({
            apiKey: chaveGemini
        });

        const promptSistema = `
Você é um organizador de seguros.

Analise a pergunta:

"${pergunta}"

Identifique qual arquivo PDF corresponde melhor à solicitação.

Considere:
- erros de digitação
- sobrenomes de solteira
- sobrenomes de casada
- abreviações
- variações de escrita

Arquivos disponíveis:

${JSON.stringify(
    ficheiros.map(f => ({
        id: f.id,
        nome: f.name
    })),
    null,
    2
)}

Responda explicando sua escolha.

Ao final coloque exatamente:

[ID:id_do_arquivo]
`;

        const response =
            await chamarGeminiComRetry(
                ai,
                promptSistema
            );

        let textoResposta = '';

        if (typeof response.text === 'function') {
            textoResposta = response.text();
        } else {
            textoResposta = response.text || '';
        }

        const matchId =
            textoResposta.match(/\[ID:(.*?)\]/i);

        let pdfUrl = null;

        if (matchId) {

            const idEncontrado =
                matchId[1].trim();

            const arquivo =
                ficheiros.find(
                    f => f.id === idEncontrado
                );

            if (
                arquivo &&
                arquivo.webViewLink
            ) {
                pdfUrl =
                    arquivo.webViewLink.replace(
                        '/view',
                        '/preview'
                    );
            }
        }

        return res.json({
            resultado:
                textoResposta
                    .replace(/\[ID:.*?\]/gi, '')
                    .trim(),
            pdfUrl
        });

    } catch (erroGeral) {

        console.error(
            '❌ Erro final:',
            erroGeral
        );

        return res.status(503).json({
            resultado:
                'O sistema está sobrecarregado no momento. Tente novamente em alguns segundos.'
        });
    }
});

app.listen(PORT, () => {
    console.log(
        `🚀 Servidor rodando com sucesso na porta ${PORT}`
    );
});
