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

// Função para converter strings para ObjectId e Date quando necessário
function parseQuery(query) {
  const parsed = { ...query };
  
  // Função recursiva para detectar e converter datas ISO para Date objects
  function convertDates(obj) {
    for (const key in obj) {
      if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key]) && !(obj[key] instanceof Date) && !(obj[key] instanceof ObjectId)) {
        // Processar objetos aninhados ($gte, $lte, $in, etc.)
        convertDates(obj[key]);
      } else if (typeof obj[key] === 'string') {
        // Detectar strings que parecem datas ISO (formato: YYYY-MM-DDTHH:mm:ss)
        const isoDatePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/;
        if (isoDatePattern.test(obj[key])) {
          try {
            const dateObj = new Date(obj[key]);
            // Verificar se é uma data válida
            if (!isNaN(dateObj.getTime())) {
              console.log(`🔄 Converting date string to Date object:`, obj[key], '→', dateObj);
              obj[key] = dateObj;
            }
          } catch (err) {
            console.log(`⚠️ Failed to convert ${obj[key]} to Date, keeping as string`);
          }
        }
      }
    }
  }
  
  // Converter campos que podem ser ObjectIds
  ['_id', 'franchise', 'franchiseId', 'store', 'storeId'].forEach(field => {
    if (parsed[field] && typeof parsed[field] === 'string' && parsed[field].length === 24) {
      try {
        console.log(`🔄 Converting ${field} from string to ObjectId:`, parsed[field]);
        parsed[field] = new ObjectId(parsed[field]);
        console.log(`✅ Converted ${field} to ObjectId:`, parsed[field]);
      } catch (err) {
        console.log(`⚠️ Failed to convert ${field} to ObjectId, keeping as string`);
      }
    }
  });
  
  // Converter strings de data para Date objects
  convertDates(parsed);
  
  console.log('📝 Query após processamento:', JSON.stringify(parsed, (key, value) => {
    if (value instanceof Date) {
      return `Date(${value.toISOString()})`;
    } else if (value instanceof ObjectId) {
      return `ObjectId(${value.toString()})`;
    }
    return value;
  }, 2));
  
  return parsed;
}

// Root endpoint
app.get('/', (req, res) => {
  console.log('🏠 Root endpoint acessado em:', new Date().toISOString());
  res.status(200).json({
    success: true,
    service: 'MongoDB TLS Proxy',
    version: '2.0.0',
    status: 'running',
    timestamp: new Date().toISOString(),
    features: [
      'Complex Aggregation Pipelines',
      'Multiple Parameter Types',
      'Enhanced Error Handling',
      'Detailed Logging',
      'ObjectId Conversion',
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

// Função para validar e processar parâmetros de query
function processQueryParameters(operation, params) {
  const { query, pipeline, filter, document, options = {} } = params;
  
  console.log('🔍 Processando parâmetros:', { 
    operation, 
    hasQuery: !!query, 
    hasPipeline: !!pipeline, 
    hasFilter: !!filter, 
    hasDocument: !!document,
    optionsKeys: Object.keys(options)
  });

  switch (operation) {
    case 'aggregate':
      if (!pipeline && !query) {
        throw new Error('Pipeline ou query é obrigatório para operação aggregate');
      }
      return { 
        pipeline: pipeline || query || [],
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

// POST /query - VERSÃO MELHORADA COM LOGS DETALHADOS
app.post('/query', async (req, res) => {
  console.log('🔍 Solicitação de query recebida');
  const startTime = Date.now();
  
  try {
    const { connectionId, collection, operation, query, pipeline, filter, document, options } = req.body;
    
    console.log('🔍 ===== PROXY QUERY DEBUG =====');
    console.log('📋 Full Request Body:', JSON.stringify(req.body, null, 2));
    console.log('🆔 ConnectionId:', connectionId);
    console.log('📊 Collection:', collection);
    console.log('⚡ Operation:', operation);
    console.log('🔍 Raw Query:', JSON.stringify(query, null, 2));
    console.log('📊 Query params:', { 
      connectionId, 
      collection, 
      operation,
      hasQuery: !!query,
      hasPipeline: !!pipeline,
      hasFilter: !!filter,
      hasDocument: !!document,
      queryType: typeof query,
      pipelineLength: Array.isArray(pipeline) ? pipeline.length : 'not-array'
    });
    
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
    
    // Processar parâmetros baseado na operação
    const processedParams = processQueryParameters(operation, {
      query,
      pipeline,
      filter,
      document,
      options
    });

    console.log('⚙️ Parâmetros processados:', {
      operation,
      processedKeys: Object.keys(processedParams),
      pipelineLength: processedParams.pipeline ? processedParams.pipeline.length : 0,
      processedQuery: JSON.stringify(processedParams.query, (key, value) => {
        if (value instanceof Date) {
          return `Date(${value.toISOString()})`;
        } else if (value instanceof ObjectId) {
          return `ObjectId(${value.toString()})`;
        }
        return value;
      }, 2)
    });
    
    // Executar operação baseada no tipo
    switch (operation) {
      case 'find':
        console.log('🔍 Executando find com query:', JSON.stringify(processedParams.query, (key, value) => {
          if (value instanceof Date) return `Date(${value.toISOString()})`;
          if (value instanceof ObjectId) return `ObjectId(${value.toString()})`;
          return value;
        }));
        result = await coll.find(processedParams.query, processedParams.options).toArray();
        console.log('📊 Find result count:', result.length);
        
        // Log first few results for debugging
        if (result.length > 0) {
          console.log('📋 First 2 results:', JSON.stringify(result.slice(0, 2), null, 2));
        } else {
          console.log('⚠️ Zero results found, testing with empty query...');
          const testResult = await coll.find({}).limit(3).toArray();
          console.log('📋 Test query (empty) returned:', testResult.length, 'documents');
          if (testResult.length > 0) {
            console.log('📋 Sample documents:', JSON.stringify(testResult, null, 2));
          }
        }
        break;
        
      case 'findOne':
        console.log('🔍 Executando findOne com query:', JSON.stringify(processedParams.query, (key, value) => {
          if (value instanceof Date) return `Date(${value.toISOString()})`;
          if (value instanceof ObjectId) return `ObjectId(${value.toString()})`;
          return value;
        }));
        result = await coll.findOne(processedParams.query, processedParams.options);
        console.log('📊 FindOne result:', result ? 'Found document' : 'No document found');
        break;
        
      case 'aggregate':
        console.log('📊 Executando aggregate com pipeline:', JSON.stringify(processedParams.pipeline, null, 2));
        if (!Array.isArray(processedParams.pipeline)) {
          throw new Error('Pipeline deve ser um array para operação aggregate');
        }
        result = await coll.aggregate(processedParams.pipeline, processedParams.options).toArray();
        console.log('📊 Aggregate result count:', result.length);
        break;
        
      case 'countDocuments':
        console.log('🔢 Executando countDocuments com query:', JSON.stringify(processedParams.query, (key, value) => {
          if (value instanceof Date) return `Date(${value.toISOString()})`;
          if (value instanceof ObjectId) return `ObjectId(${value.toString()})`;
          return value;
        }));
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
    console.log(`✅ Query executada com sucesso em ${executionTime}ms`);
    console.log('📈 Resultado:', {
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
        resultLength: Array.isArray(result) ? result.length : (result ? 1 : 0)
      }
    });
    
  } catch (error) {
    const executionTime = Date.now() - startTime;
    console.error('💥 PROXY ERROR:', error);
    console.error('💥 Error stack:', error.stack);
    console.error('📊 Request body:', JSON.stringify(req.body, null, 2));
    
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
        franchiseIdObjectCount: franchiseIdObjectResult.length,
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
