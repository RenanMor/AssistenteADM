const express = require('express');
const { GoogleGenAI } = require("@google/genai");
const { google } = require("googleapis");
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

| /*                                                                         |
| -------------------------------------------------------------------------- |
| MODELOS EM ORDEM DE PREFERÊNCIA                                            |
| -------------------------------------------------------------------------- |
| */                                                                         |
| const MODELOS_GEMINI = [                                                   |

```
'gemini-2.5-flash-lite',
'gemini-2.0-flash-lite',
'gemini-2.5-flash',
'gemini-2.0-flash'
```

];

let MODELO_ATIVO = null;

| /*                                                                         |
| -------------------------------------------------------------------------- |
| DESCOBRE O PRIMEIRO MODELO DISPONÍVEL                                      |
| -------------------------------------------------------------------------- |
| */                                                                         |
| async function encontrarModeloDisponivel(ai) {                             |

```
for (const modelo of MODELOS_GEMINI) {

    try {

        console.log(`🔍 Testando modelo: ${modelo}`);

        await ai.models.generateContent({
            model: modelo,
            contents: 'Responda apenas: OK'
        });

        console.log(`✅ Modelo disponível: ${modelo}`);

        return modelo;

    } catch (erro) {

        console.warn(
            `❌ Modelo indisponível: ${modelo}`
        );

        console.warn(
            erro?.message || erro
        );

    }
}

throw new Error(
    'Nenhum modelo Gemini disponível para esta API Key.'
);
```

}

| /*                                                                         |
| -------------------------------------------------------------------------- |
| INICIALIZA UMA ÚNICA VEZ                                                   |
| -------------------------------------------------------------------------- |
| */                                                                         |
| async function inicializarModelo(ai) {                                     |

```
if (MODELO_ATIVO) {
    return MODELO_ATIVO;
}

MODELO_ATIVO =
    await encontrarModeloDisponivel(ai);

console.log(
    `🎯 Modelo selecionado: ${MODELO_ATIVO}`
);

return MODELO_ATIVO;
```

}

| /*                                                                         |
| -------------------------------------------------------------------------- |
| CHAMADA COM RETRY                                                          |
| -------------------------------------------------------------------------- |
| */                                                                         |
| async function chamarGeminiComRetry(                                       |

```
ai,
prompt,
tentativas = 5
```

) {

```
const modelo =
    await inicializarModelo(ai);

for (let i = 0; i < tentativas; i++) {

    try {

        return await ai.models.generateContent({
            model: modelo,
            contents: prompt
        });

    } catch (erro) {

        console.warn(
            `⚠️ Tentativa ${i + 1} falhou:`,
            erro?.message || erro
        );

        // Se o modelo ficou indisponível após já ter sido selecionado
        if (
            erro?.message?.includes('404') ||
            erro?.message?.includes('NOT_FOUND')
        ) {

            console.warn(
                '♻️ Revalidando modelos disponíveis...'
            );

            MODELO_ATIVO = null;

            const novoModelo =
                await inicializarModelo(ai);

            return await ai.models.generateContent({
                model: novoModelo,
                contents: prompt
            });
        }

        if (i < tentativas - 1) {

            const espera =
                2000 * (i + 1);

            console.log(
                `⏳ Aguardando ${espera}ms...`
            );

            await new Promise(resolve =>
                setTimeout(resolve, espera)
            );

        } else {

            throw erro;

        }
    }
}
```

}

| /*                                                                         |
| -------------------------------------------------------------------------- |
| HOME                                                                       |
| -------------------------------------------------------------------------- |
| */                                                                         |
| app.get('/', (req, res) => {                                               |

```
res.sendFile(
    path.join(__dirname, 'index.html')
);
```

});

| /*                                                                         |
| -------------------------------------------------------------------------- |
| API PRINCIPAL                                                              |
| -------------------------------------------------------------------------- |
| */                                                                         |
| app.post('/api/gemini-workspace', async (req, res) => {                    |

```
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

    /*
    ------------------------------------------------------------------
    | GOOGLE DRIVE
    ------------------------------------------------------------------
    */
    const auth =
        new google.auth.GoogleAuth({
            credentials:
                JSON.parse(
                    credenciaisGoogle
                ),
            scopes: [
                'https://www.googleapis.com/auth/drive.readonly'
            ]
        });

    const drive =
        google.drive({
            version: 'v3',
            auth
        });

    const listaDrive =
        await drive.files.list({
            q: `'${pastaId}' in parents and mimeType='application/pdf' and trashed=false`,
            fields:
                'files(id,name,webViewLink)'
        });

    const ficheiros =
        listaDrive.data.files;

    if (
        !ficheiros ||
        ficheiros.length === 0
    ) {
        return res.json({
            resultado:
                'Nenhum PDF encontrado na pasta.'
        });
    }

    /*
    ------------------------------------------------------------------
    | GEMINI
    ------------------------------------------------------------------
    */
    const ai =
        new GoogleGenAI({
            apiKey: chaveGemini
        });

    const promptSistema = `
```

Você é um organizador de seguros.

Analise a pergunta abaixo:

"${pergunta}"

Identifique qual arquivo PDF é o mais compatível.

Considere:

* erros de digitação
* sobrenome de solteira
* sobrenome de casada
* nomes abreviados
* variações de escrita

Arquivos disponíveis:

${JSON.stringify(
ficheiros.map(f => ({
id: f.id,
nome: f.name
})),
null,
2
)}

Responda de forma amigável.

Ao final da resposta coloque:

[ID:id_do_arquivo]
`;

```
    const response =
        await chamarGeminiComRetry(
            ai,
            promptSistema
        );

    let textoResposta = '';

    try {

        if (
            typeof response.text ===
            'function'
        ) {

            textoResposta =
                response.text();

        } else {

            textoResposta =
                response.text || '';

        }

    } catch {

        textoResposta =
            JSON.stringify(response);

    }

    const matchId =
        textoResposta.match(
            /\[ID:(.*?)\]/i
        );

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
                .replace(
                    /\[ID:.*?\]/gi,
                    ''
                )
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
```

});

| /*                                                                         |
| -------------------------------------------------------------------------- |
| START SERVER                                                               |
| -------------------------------------------------------------------------- |
| */                                                                         |
| app.listen(PORT, () => {                                                   |

```
console.log(
    `🚀 Servidor rodando na porta ${PORT}`
);
```

});
