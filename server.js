const express = require('express');
const { GoogleGenAI } = require("@google/genai");
const { google } = require("googleapis");
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
// Serve os arquivos estáticos (HTML) da pasta public
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/gemini-workspace', async (req, res) => {
    try {
        const { pergunta } = req.body;

        if (!pergunta) {
            return res.status(400).json({ resultado: "A pergunta não foi fornecida." });
        }

        // 1. Tratamento da Chave Privada
        let chaveFormatada = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
        if (chaveFormatada) {
            chaveFormatada = chaveFormatada.replace(/^["']|["']$/g, '').replace(/\\n/g, '\n');
        }

        // 2. Autenticação Google Drive
        const auth = new google.auth.JWT(
            process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            null,
            chaveFormatada,
            ['https://www.googleapis.com/auth/drive.readonly']
        );

        const drive = google.drive({ version: 'v3', auth });
        const pastaId = process.env.GOOGLE_DRIVE_FOLDER_ID;

        const listaDrive = await drive.files.list({
            q: `'${pastaId}' in parents and mimeType='application/pdf' and trashed = false`,
            fields: 'files(id, name, webViewLink)'
        });

        const ficheiros = listaDrive.data.files;
        if (!ficheiros || ficheiros.length === 0) {
            return res.json({ resultado: "Nenhum arquivo PDF foi encontrado na pasta do Drive." });
        }

        // 3. API do Gemini
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

        const promptSistema = `Você é um assistente inteligente integrado ao Google Drive. 
        Analise a pergunta do usuário e a lista de arquivos PDFs disponíveis abaixo.
        Arquivos: ${JSON.stringify(ficheiros.map(f => ({ nome: f.name, id: f.id })))}
        
        Responda à dúvida de forma clara. No final da resposta, inclua o ID do arquivo no formato [ID:identificador] e a página no formato [PAGINA:numero].
        Pergunta: ${pergunta}`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: promptSistema
        });

        const textoResposta = response.text;
        const matchId = textoResposta.match(/\[ID:(.*?)\]/);
        const matchPagina = textoResposta.match(/\[PAGINA:(\d+)\]/);

        let idEncontrado = null;
        let paginaEncontrada = 1;
        let pdfUrl = null;

        if (matchId) idEncontrado = matchId[1].trim();
        if (matchPagina) paginaEncontrada = parseInt(matchPagina[1]);

        if (idEncontrado) {
            const fCorrespondente = ficheiros.find(f => f.id === idEncontrado);
            if (fCorrespondente && fCorrespondente.webViewLink) {
                pdfUrl = fCorrespondente.webViewLink.replace('/view', '/preview');
            }
        }

        const respostaLimpa = textoResposta.replace(/\[ID:.*?\]|\[PAGINA:\d+\]/g, '').trim();

        return res.json({
            resultado: respostaLimpa,
            pdfUrl: pdfUrl,
            pagina: paginaEncontrada
        });

    } catch (erro) {
        console.error(erro);
        return res.status(500).json({ resultado: `Erro interno: ${erro.message}` });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});