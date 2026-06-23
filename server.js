const express = require('express');
const { GoogleGenAI } = require("@google/genai");
const { google } = require("googleapis");
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));

// Serve os arquivos estáticos diretamente da raiz do projeto
app.use(express.static(__dirname));

// Rota principal para abrir o index.html automaticamente
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Rota que processa a pesquisa no Drive e envia para o Gemini
app.post('/api/gemini-workspace', async (req, res) => {
    try {
        const { pergunta } = req.body;

        if (!pergunta) {
            return res.status(400).json({ resultado: "A pergunta não foi fornecida." });
        }

        // 1. Captura das Variáveis de Ambiente do Render
        const credenciaisGoogle = process.env.GOOGLE_CREDENTIALS;
        const pastaId = process.env.GOOGLE_DRIVE_FOLDER_ID;
        const chaveGemini = process.env.GEMINI_API_KEY;

        if (!credenciaisGoogle || !pastaId || !chaveGemini) {
            console.error("❌ ERRO: Variáveis de ambiente ausentes no painel do Render.");
            return res.status(500).json({ 
                resultado: `Erro de Configuração: Chaves ausentes no Render. Google Credentials: ${!!credenciaisGoogle}, ID Pasta: ${!!pastaId}, Chave Gemini: ${!!chaveGemini}` 
            });
        }

        // 2. Autenticação robusta com GoogleAuth (Lê o arquivo JSON completo automaticamente)
        let auth;
        try {
            auth = new google.auth.GoogleAuth({
                credentials: JSON.parse(credenciaisGoogle),
                scopes: ['https://www.googleapis.com/auth/drive.readonly']
            });
        } catch (erroJson) {
            console.error("❌ ERRO NO PARSE DO JSON (GOOGLE_CREDENTIALS):", erroJson.message);
            return res.status(500).json({ resultado: "Erro no Servidor: A variável GOOGLE_CREDENTIALS não contém um JSON válido. Copie todo o conteúdo do arquivo .json." });
        }

        const drive = google.drive({ version: 'v3', auth });

        // 3. Listagem de arquivos da pasta do Google Drive
        let listaDrive;
        try {
            listaDrive = await drive.files.list({
                q: `'${pastaId}' in parents and mimeType='application/pdf' and trashed = false`,
                fields: 'files(id, name, webViewLink)'
            });
        } catch (erroDrive) {
            console.error("❌ ERRO NO GOOGLE DRIVE API:", erroDrive.message);
            return res.status(500).json({ 
                resultado: `O Google Drive recusou o acesso. Detalhes: ${erroDrive.message}` 
            });
        }

        const ficheiros = listaDrive.data.files;
        if (!ficheiros || ficheiros.length === 0) {
            return res.json({ resultado: "Nenhum arquivo PDF foi localizado dentro da pasta configurada no Google Drive." });
        }

        // 4. Inicialização da API do Gemini
        const ai = new GoogleGenAI({ apiKey: chaveGemini });

        const promptSistema = `Você é um assistente inteligente integrado ao Google Drive de uma corretora de seguros. 
        Analise a pergunta do usuário e a lista de arquivos PDFs disponíveis abaixo para encontrar a resposta correta.
        
        Arquivos disponíveis na pasta do Drive: ${JSON.stringify(ficheiros.map(f => ({ nome: f.name, id: f.id })))}
        
        Responda à dúvida do usuário de forma clara e profissional. 
        OBRIGATORIAMENTE, no final da sua resposta, inclua o ID do arquivo correto no formato [ID:identificador_do_arquivo] e a página estimada no formato [PAGINA:numero_da_pagina].
        Exemplo de final de resposta: "... O valor total é R$ 1.500. [ID:1A2B3C4D] [PAGINA:3]"
        
        Pergunta do usuário: ${pergunta}`;

        let response;
        try {
            response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: promptSistema
            });
        } catch (erroGemini) {
            console.error("❌ ERRO NA API DO GEMINI:", erroGemini.message);
            return res.status(500).json({ resultado: `Falha na API do Gemini: ${erroGemini.message}` });
        }

        const textoResposta = response.text;

        // 5. Extração de Metadados para o iframe lateral
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

        // Limpa as tags do texto enviado ao chat
        const respostaLimpa = textoResposta.replace(/\[ID:.*?\]|\[PAGINA:\d+\]/g, '').trim();

        return res.json({
            resultado: respostaLimpa,
            pdfUrl: pdfUrl,
            pagina: paginaEncontrada
        });

    } catch (erroGeral) {
        console.error("❌ ERRO CRÍTICO NO SERVIDOR:", erroGeral);
        return res.status(500).json({ resultado: `Erro inesperado interno no servidor: ${erroGeral.message}` });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando com sucesso na porta ${PORT}`);
});
