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

// Função auxiliar para chamar o Gemini com Plano B automático se o servidor principal falhar (Erro 503)
async function chamarGeminiComFallback(ai, params) {
    try {
        return await ai.models.generateContent({ model: 'gemini-2.5-flash', ...params });
    } catch (erro) {
        console.warn("⚠️ Modelo principal (2.5-flash) indisponível. Acionando backup (1.5-flash)...");
        return await ai.models.generateContent({ model: 'gemini-1.5-flash', ...params });
    }
}

// Rota que processa a pesquisa profunda dentro dos PDFs do Drive
app.post('/api/gemini-workspace', async (req, res) => {
    try {
        const { pergunta } = req.body;

        if (!pergunta) {
            return res.status(400).json({ resultado: "A pergunta não foi fornecida." });
        }

        const credenciaisGoogle = process.env.GOOGLE_CREDENTIALS;
        const pastaId = process.env.GOOGLE_DRIVE_FOLDER_ID;
        const chaveGemini = process.env.GEMINI_API_KEY;

        if (!credenciaisGoogle || !pastaId || !chaveGemini) {
            console.error("❌ ERRO: Variáveis de ambiente ausentes no Render.");
            return res.status(500).json({ resultado: "Erro de Configuração: Chaves ausentes no painel do Render." });
        }

        // 1. Autenticação com o Google Drive
        let auth;
        try {
            auth = new google.auth.GoogleAuth({
                credentials: JSON.parse(credenciaisGoogle),
                scopes: ['https://www.googleapis.com/auth/drive.readonly']
            });
        } catch (erroJson) {
            console.error("❌ ERRO NO PARSE DO JSON:", erroJson.message);
            return res.status(500).json({ resultado: "Erro no Servidor: Estrutura da credencial do Google inválida." });
        }

        const drive = google.drive({ version: 'v3', auth });

        // 2. Lista os arquivos disponíveis na pasta
        let listaDrive;
        try {
            listaDrive = await drive.files.list({
                q: `'${pastaId}' in parents and mimeType='application/pdf' and trashed = false`,
                fields: 'files(id, name, webViewLink)'
            });
        } catch (erroDrive) {
            console.error("❌ ERRO NO GOOGLE DRIVE API:", erroDrive.message);
            return res.status(500).json({ resultado: `O Google Drive recusou a listagem: ${erroDrive.message}` });
        }

        const ficheiros = listaDrive.data.files;
        if (!ficheiros || ficheiros.length === 0) {
            return res.json({ resultado: "Nenhum arquivo PDF foi localizado dentro da pasta configurada no Google Drive." });
        }

        // 3. Inicializa a API do Gemini
        const ai = new GoogleGenAI({ apiKey: chaveGemini });

        // ETAPA 1: Triagem Inteligente (Descobrir qual arquivo abrir baseado na pergunta)
        const promptSelecao = `Analise a pergunta do usuário e determine qual dos arquivos abaixo é o correto para ler e responder à dúvida.
        
        Arquivos disponíveis: ${JSON.stringify(ficheiros.map(f => ({ id: f.id, nome: f.name })))}
        Pergunta do usuário: "${pergunta}"
        
        Responda APENAS E EXCLUSIVAMENTE com o ID do arquivo correspondente (ex: 1A2B3C4D). Se for uma pergunta geral ou nenhum arquivo servir, responda apenas: NONE`;

        let respostaSelecao;
        try {
            respostaSelecao = await chamarGeminiComFallback(ai, { contents: promptSelecao });
        } catch (e) {
            console.error("❌ Falha na etapa de triagem do Gemini:", e.message);
            return res.status(503).json({ resultado: "Os servidores do Gemini estão instáveis. Tente novamente em alguns segundos." });
        }

        const textoSelecao = respostaSelecao.text || "";
        
        // Localiza qual dos nossos arquivos bate com a seleção do Gemini (seguro contra textos extras)
        const arquivoAlvo = ficheiros.find(f => textoSelecao.includes(f.id));

        // Se nenhum arquivo específico foi selecionado pelo Gemini
        if (!arquivoAlvo) {
            return res.json({
                resultado: "Não consegui identificar uma apólice ou cliente específico para essa pergunta. Por favor, digite o nome do cliente de forma clara.",
                pdfUrl: null,
                pagina: 1
            });
        }

        console.log(`📂 Arquivo identificado para leitura profunda: ${arquivoAlvo.name}`);

        // ETAPA 2: Download do binário do PDF do Google Drive
        let pdfBuffer;
        try {
            const download = await drive.files.get(
                { fileId: arquivoAlvo.id, alt: 'media' },
                { responseType: 'arraybuffer' }
            );
            pdfBuffer = Buffer.from(download.data);
        } catch (erroDownload) {
            console.error(`❌ Erro ao baixar o PDF ${arquivoAlvo.name}:`, erroDownload.message);
            return res.status(500).json({ resultado: `Não consegui ler o arquivo do Drive. Verifique se ele está corrompido.` });
        }

        // ETAPA 3: Leitura Multimodal Profunda (O Gemini lê o PDF de verdade)
        const promptFinal = `Você é um assistente integrado ao sistema de uma corretora de seguros.
        Analise cuidadosamente o documento PDF anexo ("${arquivoAlvo.name}") para responder à dúvida do usuário.
        
        Pergunta do usuário: "${pergunta}"
        
        Diretrizes da resposta:
        1. Seja altamente preciso, detalhado e profissional com base nos dados do PDF.
        2. OBRIGATORIAMENTE, no final do seu texto, informe em qual página do documento você encontrou essa resposta usando exatamente o padrão [PAGINA:numero]. Exemplo: "... Conforme a cláusula x, o prêmio é de R$ 500. [PAGINA:3]"
        3. Se a informação solicitada não existir dentro deste PDF, diga de forma honesta que não localizou o dado no documento.`;

        let respostaFinal;
        try {
            respostaFinal = await chamarGeminiComFallback(ai, {
                contents: [
                    {
                        inlineData: {
                            data: pdfBuffer.toString("base64"),
                            mimeType: "application/pdf"
                        }
                    },
                    promptFinal
                ]
            });
        } catch (erroGeminiFinal) {
            console.error("❌ Erro na leitura profunda do Gemini:", erroGeminiFinal.message);
            return res.status(503).json({ resultado: "Erro ao processar o conteúdo do PDF com a inteligência artificial. Tente novamente." });
        }

        const textoResposta = respostaFinal.text || "";

        // 4. Extração da página para sincronizar o iframe lateral
        const matchPagina = textoResposta.match(/\[PAGINA:(\d+)\]/);
        let paginaEncontrada = 1;
        if (matchPagina) paginaEncontrada = parseInt(matchPagina[1]);

        // Limpa a tag técnica antes de exibir o texto no chat
        const respostaLimpa = textoResposta.replace(/\[PAGINA:\d+\]/g, '').trim();

        // Altera a URL para o modo preview (compatível com iframes)
        const pdfUrlOriginal = arquivoAlvo.webViewLink || "";
        const pdfUrlPreview = pdfUrlOriginal.replace('/view', '/preview');

        return res.json({
            resultado: respostaLimpa,
            pdfUrl: pdfUrlPreview,
            pagina: paginaEncontrada
        });

    } catch (erroGeral) {
        console.error("❌ ERRO CRÍTICO NO SERVIDOR:", erroGeral);
        return res.status(500).json({ resultado: `Erro crítico interno: ${erroGeral.message}` });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor Workspace rodando com sucesso na porta ${PORT}`);
});
