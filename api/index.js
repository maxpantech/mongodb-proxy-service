const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));

// Armazenar conexões ativas
const activeConnections = new Map();

console.log('🚀 MongoDB TLS Proxy Service iniciado');

// NOVA FUNÇÃO: Processar funções MongoDB em pipelines de agregação
function processMongoPipeline(pipeline) {
  if (!Array.isArray(pipeline)) {
    return pipeline;
  }

  console.log('🔧 Processando pipeline MongoDB:', JSON.stringify(pipeline, null, 2));

  const processedPipeline = pipeline.map(stage => {
    return processMongoStage(stage);
  });

  console.log('✅ Pipeline processado:', JSON.stringify(processedPipeline, null, 2));
  return processedPipeline;
}

// NOVA FUNÇÃO: Processar estágio individual do pipeline
function processMongoStage(stage) {
  if (typeof stage !== 'object' || stage === null) {
    return stage;
  }

  const processed = {};
  
  for (const [key, value] of Object.entries(stage)) {
    processed[key] = processMongoValue(value);
  }
  
  return processed;
}

// NOVA FUNÇÃO: Processar valores com funções MongoDB
function processMongoValue(value) {
  if (typeof value === 'string') {
    // Processar ISODate("...")
    const isoDateMatch = value.match(/^ISODate\("([^"]+)"\)$/);
    if (isoDateMatch) {
      console.log(`🔄 Converting ISODate string to Date:`, isoDateMatch[1]);
      return new Date(isoDateMatch[1]);
    }
    
    // Processar ObjectId("...")
    const objectIdMatch = value.match(/^ObjectId\("([a-fA-F0-9]{24})"\)$/);
    if (objectIdMatch) {
      console.log(`🔄 Converting ObjectId string to ObjectId:`, objectIdMatch[1]);
      return new ObjectId(objectIdMatch[1]);
    }
    
    // Detectar strings que parecem datas ISO (formato: YYYY-MM-DDTHH:mm:ss)
    const isoDatePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/;
    if (isoDatePattern.test(value)) {
      try {
        const dateObj = new Date(value);
        if (!isNaN(dateObj.getTime())) {
          console.log(`🔄 Converting ISO date string to Date:`, value, '→', dateObj);
          return dateObj;
        }
      } catch (err) {
        console.log(`⚠️ Failed to convert ${value} to Date, keeping as string`);
      }
    }
    
    return value;
  } else if (Array.isArray(value)) {
    return value.map(item => processMongoValue(item));
  } else if (typeof value === 'object' && value !== null) {
    const processed = {};
    for (const [k, v] of Object.entries(value)) {
      processed[k] = processMongoValue(v);
    }
    return processed;
  }
  
  return value;
}

// Função para converter strings para ObjectId e Date quando necessário - ATUALIZADA
function parseQuery(query) {
  const parsed = { ...query };
  
  console.log('🔍 parseQuery - Input:', JSON.stringify(parsed, null, 2));
  
  // Processar com a nova função de valores MongoDB
  const result = processMongoValue(parsed);
  
  console.log('📝 parseQuery - Output:', JSON.stringify(result, (key, value) => {
    if (value instanceof Date) {
      return `Date(${value.toISOString()})`;
    } else if (value instanceof ObjectId) {
      return `ObjectId(${value.toString()})`;
    }
    return value;
  }, 2));
  
  return result;
}

// Root endpoint
app.get('/', (req, res) => {
  console.log('🏠 Root endpoint acessado em:', new Date().toISOString());
  res.status(200).json({
    success: true,
    service: 'MongoDB TLS Proxy',
    version: '2.1.0',
    status: 'running',
    timestamp: new Date().toISOString(),
    features: [
      'Complex Aggregation Pipelines',
      'MongoDB Function Processing (ISODate, ObjectId)',
      'Enhanced Error Handling',
      'Detailed Logging',
      'Pipeline Value Processing',
      'Debug Endpoints'
    ],
    endpoints: {
      health: '/health',
      status: '/status',
      connect: 'POST /connect',
      query: 'POST /query',
      collections: 'GET /collections/:connectionId',
      disconnect: 'DELETE /disconnect/:connectionId',
      debugStores: 'POST /debug-stores'
    }
  });
});

// Health check
app.get('/health', (req, res) => {
  console.log('❤️ Health check acessado');
  res.status(200).json({ 
    status: 'ok', 
    service: 'mongodb-tls-proxy',
    timestamp: new Date().toISOString() 
  });
});

// Status endpoint
app.get('/status', (req, res) => {
  console.log('📊 Status endpoint acessado');
  res.status(200).json({
    success: true,
    activeConnections: activeConnections.size,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString()
  });
});

// Função para criar conexão MongoDB com TLS
async function createMongoConnection(config) {
  const { mongoUrl, database, tlsConfig } = config;
  
  console.log('🔗 Criando conexão MongoDB TLS...', { database, tlsEnabled: tlsConfig?.enabled });
  
  const options = {
    connectTimeoutMS: 30000,
    serverSelectionTimeoutMS: 30000,
  };

  if (tlsConfig?.enabled) {
    options.tls = true;
    options.tlsAllowInvalidCertificates = tlsConfig.insecure || false;
    options.tlsAllowInvalidHostnames = tlsConfig.insecure || false;
    
    if (tlsConfig.caFile) {
      console.log('📜 Aplicando certificado CA:', tlsConfig.caFile);
      options.tlsCAFile = tlsConfig.caFile;
    }
    if (tlsConfig.certFile) {
      console.log('🔑 Aplicando certificado cliente:', tlsConfig.certFile);
      options.tlsCertificateKeyFile = tlsConfig.certFile;
    }
    
    console.log('🔒 Configurações TLS aplicadas:', {
      tls: options.tls,
      tlsAllowInvalidCertificates: options.tlsAllowInvalidCertificates,
      tlsAllowInvalidHostnames: options.tlsAllowInvalidHostnames,
      hasCaFile: !!options.tlsCAFile,
      hasCertFile: !!options.tlsCertificateKeyFile
    });
  }

  console.log('🔌 Tentando conectar com MongoDB...');
  const client = new MongoClient(mongoUrl, options);
  await client.connect();
  console.log('✅ MongoDB conectado com sucesso!');
  
  return { client, db: client.db(database) };
}

// Função para validar e processar parâmetros de query - ATUALIZADA
function processQueryParameters(operation, params) {
  const { query, pipeline, filter, document, options = {} } = params;
  
  console.log('🔍 processQueryParameters - Input:', { 
    operation, 
    hasQuery: !!query, 
    hasPipeline: !!pipeline, 
    hasFilter: !!filter, 
    hasDocument: !!document,
    optionsKeys: Object.keys(options),
    pipelineType: typeof pipeline,
    pipelineIsArray: Array.isArray(pipeline)
  });

  switch (operation) {
    case 'aggregate':
      let processedPipeline = pipeline || query || [];
      
      // Se recebemos uma string que parece ser um array, tentar fazer parse
      if (typeof processedPipeline === 'string') {
        try {
          processedPipeline = JSON.parse(processedPipeline);
        } catch (e) {
          console.error('❌ Erro ao fazer parse do pipeline string:', e.message);
          throw new Error('Pipeline deve ser um array válido para operação aggregate');
        }
      }
      
      if (!Array.isArray(processedPipeline)) {
        throw new Error('Pipeline deve ser um array para operação aggregate');
      }
      
      // NOVA FUNCIONALIDADE: Processar funções MongoDB no pipeline
      const finalPipeline = processMongoPipeline(processedPipeline);
      
      console.log('✅ Pipeline processado para aggregate:', JSON.stringify(finalPipeline, (key, value) => {
        if (value instanceof Date) return `Date(${value.toISOString()})`;
        if (value instanceof ObjectId) return `ObjectId(${value.toString()})`;
        return value;
      }, 2));
      
      return { 
        pipeline: finalPipeline,
        options: options || {}
      };

    case 'find':
    case 'findOne':
    case 'countDocuments':
      const processedQuery = parseQuery(query || filter || {});
      return {
        query: processedQuery,
        options: options || {}
      };

    case 'insertOne':
    case 'insertMany':
      return {
        document: document || query,
        options: options || {}
      };

    case 'updateOne':
    case 'updateMany':
    case 'deleteOne':
    case 'deleteMany':
      return {
        filter: parseQuery(filter || query || {}),
        document: document,
        options: options || {}
      };

    default:
      return {
        query: parseQuery(query || {}),
        pipeline: pipeline,
        filter: parseQuery(filter || {}),
        document: document,
        options: options || {}
      };
  }
}

// POST /connect
app.post('/connect', async (req, res) => {
  console.log('📥 Solicitação de conexão recebida');
  
  try {
    const { connectionId, mongoUrl, database, tlsConfig } = req.body;
    
    console.log('Dados da conexão:', { connectionId, database, tlsEnabled: tlsConfig?.enabled });
    
    if (!connectionId || !mongoUrl || !database) {
      return res.status(400).json({
        success: false,
        error: 'connectionId, mongoUrl e database são obrigatórios'
      });
    }

    // Escrever certificados se fornecidos
    let certFiles = null;
    if (tlsConfig?.enabled && (tlsConfig.caCert || tlsConfig.clientCert)) {
      const tempDir = '/tmp';
      
      if (tlsConfig.caCert) {
        const caFile = path.join(tempDir, `ca_${connectionId}.pem`);
        console.log('💾 Salvando certificado CA em:', caFile);
        fs.writeFileSync(caFile, tlsConfig.caCert);
        certFiles = { caFile };
      }
      
      if (tlsConfig.clientCert) {
        const certFile = path.join(tempDir, `cert_${connectionId}.pem`);
        console.log('💾 Salvando certificado cliente em:', certFile);
        fs.writeFileSync(certFile, tlsConfig.clientCert);
        if (!certFiles) certFiles = {};
        certFiles.certFile = certFile;
      }
      
      console.log('📁 Certificados salvos:', certFiles);
    }
    
    const config = {
      mongoUrl,
      database,
      tlsConfig: tlsConfig?.enabled ? {
        enabled: true,
        insecure: tlsConfig.insecure || false,
        caFile: certFiles?.caFile,
        certFile: certFiles?.certFile
      } : { enabled: false }
    };
    
    console.log('⚙️ Configuração final:', {
      database: config.database,
      tlsEnabled: config.tlsConfig.enabled,
      hasCaFile: !!config.tlsConfig.caFile,
      hasCertFile: !!config.tlsConfig.certFile
    });
    
    const connection = await createMongoConnection(config);
    activeConnections.set(connectionId, {
      ...connection,
      config,
      certFiles,
      createdAt: new Date()
    });
    
    // Testar conexão
    console.log('🏓 Testando conexão com ping...');
    await connection.db.admin().ping();
    console.log('🎯 Ping bem-sucedido');
    
    res.status(200).json({
      success: true,
      message: 'Conexão TLS estabelecida com sucesso',
      connectionId,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Erro na conexão:', error);
    console.error('Stack trace:', error.stack);
    res.status(500).json({
      success: false,
      error: 'Falha na conexão TLS',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// POST /query - VERSÃO ATUALIZADA COM PROCESSAMENTO APRIMORADO
app.post('/query', async (req, res) => {
  console.log('🔍 ========== NOVA SOLICITAÇÃO DE QUERY ==========');
  const startTime = Date.now();
  
  try {
    const { connectionId, collection, operation, query, pipeline, filter, document, options } = req.body;
    
    console.log('📋 Request completo:', JSON.stringify(req.body, null, 2));
    console.log('🆔 ConnectionId:', connectionId);
    console.log('📊 Collection:', collection);
    console.log('⚡ Operation:', operation);
    
    if (!connectionId || !collection || !operation) {
      return res.status(400).json({
        success: false,
        error: 'connectionId, collection e operation são obrigatórios'
      });
    }
    
    const connection = activeConnections.get(connectionId);
    if (!connection) {
      console.error('❌ Connection not found:', connectionId);
      return res.status(404).json({
        success: false,
        error: 'Conexão não encontrada'
      });
    }

    console.log('✅ Connection found, executing operation...');
    
    const coll = connection.db.collection(collection);
    let result;
    
    // Processar parâmetros com a nova função aprimorada
    const processedParams = processQueryParameters(operation, {
      query,
      pipeline,
      filter,
      document,
      options
    });

    console.log('⚙️ Parâmetros FINAIS processados:', {
      operation,
      processedKeys: Object.keys(processedParams),
      pipelineLength: processedParams.pipeline ? processedParams.pipeline.length : 0
    });
    
    // Executar operação baseada no tipo
    switch (operation) {
      case 'find':
        console.log('🔍 Executando find com query processada');
        result = await coll.find(processedParams.query, processedParams.options).toArray();
        console.log('📊 Find result count:', result.length);
        break;
        
      case 'findOne':
        console.log('🔍 Executando findOne com query processada');
        result = await coll.findOne(processedParams.query, processedParams.options);
        console.log('📊 FindOne result:', result ? 'Found document' : 'No document found');
        break;
        
      case 'aggregate':
        console.log('📊 Executando aggregate com pipeline PROCESSADO');
        console.log('🔧 Pipeline final:', JSON.stringify(processedParams.pipeline, (key, value) => {
          if (value instanceof Date) return `Date(${value.toISOString()})`;
          if (value instanceof ObjectId) return `ObjectId(${value.toString()})`;
          return value;
        }, 2));
        
        result = await coll.aggregate(processedParams.pipeline, processedParams.options).toArray();
        console.log('📊 Aggregate result count:', result.length);
        
        // Log detalhado para debug da sua query específica
        if (result.length > 0) {
          console.log('📋 Primeiros resultados da agregação:', JSON.stringify(result.slice(0, 2), null, 2));
        } else {
          console.log('⚠️ Nenhum resultado na agregação - verificando dados...');
          
          // Debug: verificar se existem documentos na collection
          const totalDocs = await coll.countDocuments({});
          console.log('📊 Total de documentos na collection:', totalDocs);
          
          if (totalDocs > 0) {
            const sampleDoc = await coll.findOne({});
            console.log('📋 Documento de exemplo:', JSON.stringify(sampleDoc, null, 2));
          }
        }
        break;
        
      case 'countDocuments':
        console.log('🔢 Executando countDocuments com query processada');
        result = await coll.countDocuments(processedParams.query, processedParams.options);
        console.log('📊 Count result:', result);
        break;
        
      case 'insertOne':
        console.log('📝 Executando insertOne');
        result = await coll.insertOne(processedParams.document, processedParams.options);
        break;
        
      case 'insertMany':
        console.log('📝 Executando insertMany');
        result = await coll.insertMany(processedParams.document, processedParams.options);
        break;
        
      case 'updateOne':
        console.log('✏️ Executando updateOne');
        result = await coll.updateOne(processedParams.filter, processedParams.document, processedParams.options);
        break;
        
      case 'updateMany':
        console.log('✏️ Executando updateMany');
        result = await coll.updateMany(processedParams.filter, processedParams.document, processedParams.options);
        break;
        
      case 'deleteOne':
        console.log('🗑️ Executando deleteOne');
        result = await coll.deleteOne(processedParams.filter, processedParams.options);
        break;
        
      case 'deleteMany':
        console.log('🗑️ Executando deleteMany');
        result = await coll.deleteMany(processedParams.filter, processedParams.options);
        break;
        
      default:
        console.error('❌ Unsupported operation:', operation);
        throw new Error(`Operação não suportada: ${operation}`);
    }
    
    const executionTime = Date.now() - startTime;
    console.log(`✅ Query executada com SUCESSO em ${executionTime}ms`);
    console.log('📈 Resultado final:', {
      type: typeof result,
      isArray: Array.isArray(result),
      length: Array.isArray(result) ? result.length : 'not-array',
      hasData: !!result
    });
    
    res.status(200).json({
      success: true,
      data: result,
      executionTime: executionTime,
      timestamp: new Date().toISOString(),
      diagnostics: {
        operation,
        collection,
        parametersUsed: Object.keys(processedParams),
        resultType: typeof result,
        resultLength: Array.isArray(result) ? result.length : (result ? 1 : 0),
        pipelineProcessed: operation === 'aggregate' ? 'yes' : 'no'
      }
    });
    
  } catch (error) {
    const executionTime = Date.now() - startTime;
    console.error('💥 ERRO CRÍTICO NA QUERY:', error);
    console.error('💥 Error stack completo:', error.stack);
    console.error('📊 Request body que causou erro:', JSON.stringify(req.body, null, 2));
    
    res.status(500).json({
      success: false,
      error: 'Falha na execução da query',
      details: error.message,
      executionTime: executionTime,
      timestamp: new Date().toISOString(),
      diagnostics: {
        operation: req.body.operation,
        collection: req.body.collection,
        errorType: error.name,
        errorStack: error.stack
      }
    });
  }
});

// POST /debug-stores - ENDPOINT PARA DEBUG ESPECÍFICO
app.post('/debug-stores', async (req, res) => {
  try {
    const { connectionId, franchiseId } = req.body;
    
    const connection = activeConnections.get(connectionId);
    if (!connection) {
      return res.status(404).json({ success: false, error: 'Connection not found' });
    }

    console.log('🔍 ===== DEBUG STORES SEARCH =====');
    console.log('🆔 Franchise ID to search:', franchiseId);

    // Teste 1: Contar total de documentos
    const totalCount = await connection.db.collection('stores').countDocuments({});
    console.log('📊 Total stores in collection:', totalCount);

    // Teste 2: Buscar primeiros 5 documentos para ver estrutura
    const sampleStores = await connection.db.collection('stores').find({}).limit(5).toArray();
    console.log('📋 Sample stores structure:', JSON.stringify(sampleStores, null, 2));

    // Teste 3: Buscar com franchise como string
    const stringQuery = { franchise: franchiseId };
    const stringResult = await connection.db.collection('stores').find(stringQuery).limit(5).toArray();
    console.log('🔍 String query result count:', stringResult.length);

    // Teste 4: Buscar com franchise como ObjectId
    const objectIdQuery = { franchise: new ObjectId(franchiseId) };
    const objectIdResult = await connection.db.collection('stores').find(objectIdQuery).limit(5).toArray();
    console.log('🔍 ObjectId query result count:', objectIdResult.length);

    // Teste 5: Buscar com franchiseId como string
    const franchiseIdStringQuery = { franchiseId: franchiseId };
    const franchiseIdStringResult = await connection.db.collection('stores').find(franchiseIdStringQuery).limit(5).toArray();
    console.log('🔍 FranchiseId string query result count:', franchiseIdStringResult.length);

    // Teste 6: Buscar com franchiseId como ObjectId
    const franchiseIdObjectQuery = { franchiseId: new ObjectId(franchiseId) };
    const franchiseIdObjectResult = await connection.db.collection('stores').find(franchiseIdObjectQuery).limit(5).toArray();
    console.log('🔍 FranchiseId ObjectId query result count:', franchiseIdObjectResult.length);

    res.json({
      success: true,
      debug: {
        totalCount,
        sampleStores: sampleStores.length,
        stringQueryCount: stringResult.length,
        objectIdQueryCount: objectIdResult.length,
        franchiseIdStringCount: franchiseIdStringResult.length,
        franchiseIdObjectCount: objectIdObjectResult.length,
        firstSample: sampleStores[0] || null
      }
    });

  } catch (error) {
    console.error('💥 Debug error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /collections/:connectionId
app.get('/collections/:connectionId', async (req, res) => {
  console.log('📚 Solicitação de listagem de collections');
  
  try {
    const { connectionId } = req.params;
    
    console.log('Connection ID:', connectionId);
    
    const connection = activeConnections.get(connectionId);
    if (!connection) {
      return res.status(404).json({
        success: false,
        error: 'Conexão não encontrada'
      });
    }
    
    const collections = await connection.db.listCollections().toArray();
    const collectionsData = [];
    
    for (const collInfo of collections) {
      try {
        const coll = connection.db.collection(collInfo.name);
        const count = await coll.countDocuments();
        
        collectionsData.push({
          name: collInfo.name,
          type: collInfo.type,
          documentCount: count,
          sizeBytes: 0,
          avgDocSize: 0
        });
        
      } catch (collError) {
        collectionsData.push({
          name: collInfo.name,
          type: collInfo.type,
          documentCount: 0,
          sizeBytes: 0,
          avgDocSize: 0,
          error: collError.message
        });
      }
    }
    
    console.log('✅ Collections listadas com sucesso');
    
    res.status(200).json({
      success: true,
      collections: collectionsData,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Erro ao listar collections:', error);
    res.status(500).json({
      success: false,
      error: 'Falha ao listar collections',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// DELETE /disconnect/:connectionId
app.delete('/disconnect/:connectionId', async (req, res) => {
  console.log('🔌 Solicitação de desconexão');
  
  try {
    const { connectionId } = req.params;
    
    console.log('Desconectando:', connectionId);
    
    const connection = activeConnections.get(connectionId);
    if (!connection) {
      return res.status(404).json({
        success: false,
        error: 'Conexão não encontrada'
      });
    }
    
    await connection.client.close();
    
    // Limpar certificados
    if (connection.certFiles) {
      try {
        if (connection.certFiles.caFile) fs.unlinkSync(connection.certFiles.caFile);
        if (connection.certFiles.certFile) fs.unlinkSync(connection.certFiles.certFile);
      } catch (cleanupError) {
        console.log('⚠️ Erro ao limpar certificados:', cleanupError.message);
      }
    }
    
    activeConnections.delete(connectionId);
    
    console.log('✅ Desconexão realizada com sucesso');
    
    res.status(200).json({
      success: true,
      message: 'Conexão encerrada com sucesso',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Erro ao desconectar:', error);
    res.status(500).json({
      success: false,
      error: 'Falha ao desconectar',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Handle 404s
app.use('*', (req, res) => {
  console.log('🔍 404 - Rota não encontrada:', req.method, req.originalUrl);
  res.status(404).json({
    success: false,
    error: 'Rota não encontrada',
    method: req.method,
    url: req.originalUrl,
    timestamp: new Date().toISOString()
  });
});

// Error handler
app.use((error, req, res, next) => {
  console.error('💥 Erro não tratado:', error);
  res.status(500).json({
    success: false,
    error: 'Erro interno do servidor',
    details: error.message,
    timestamp: new Date().toISOString()
  });
});

// Exportar para Vercel
module.exports = app;
