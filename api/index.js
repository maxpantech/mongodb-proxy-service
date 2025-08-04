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

// ✅ NOVO: Armazenar pools de conexão otimizados
const connectionPools = new Map();

console.log('🚀 MongoDB TLS Proxy Service iniciado com Pool de Conexões');

// Função para converter strings para ObjectId quando necessário
function parseQuery(query) {
  const parsed = { ...query };
  
  // Converter campos que podem ser ObjectIds
  ['_id', 'franchise', 'franchiseId'].forEach(field => {
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
      'connection-pooling',
      'tls-support', 
      'timeout-management',
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
    activePools: connectionPools.size,
    timestamp: new Date().toISOString() 
  });
});

// Status endpoint
app.get('/status', (req, res) => {
  console.log('📊 Status endpoint acessado');
  
  const poolStats = [];
  connectionPools.forEach((pool, connectionId) => {
    poolStats.push({
      connectionId,
      totalConnections: pool.client.topology?.s?.servers?.size || 0,
      isConnected: pool.client.topology?.isConnected() || false,
      createdAt: pool.createdAt
    });
  });

  res.status(200).json({
    success: true,
    activePools: connectionPools.size,
    poolStats,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString()
  });
});

// ✅ NOVA: Função para criar pool de conexões MongoDB otimizado
async function createMongoConnectionPool(config) {
  const { mongoUrl, database, tlsConfig } = config;
  
  console.log('🔗 Criando POOL de conexões MongoDB TLS...', { 
    database, 
    tlsEnabled: tlsConfig?.enabled 
  });
  
  // ✅ Configurações otimizadas do pool de conexões
  const options = {
    // Pool de conexões otimizado
    maxPoolSize: 10,           // Máximo 10 conexões no pool
    minPoolSize: 2,            // Mínimo 2 conexões sempre ativas
    maxIdleTimeMS: 30000,      // 30s timeout para conexões ociosas
    waitQueueMultiple: 5,      // Queue size multiplier
    waitQueueTimeoutMS: 10000, // 10s timeout na queue
    
    // Timeouts otimizados
    connectTimeoutMS: 30000,
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 45000,    // 45s para queries pesadas
    heartbeatFrequencyMS: 10000,
    
    // Retry e reconexão
    retryWrites: true,
    retryReads: true,
    maxStalenessSeconds: 90,
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
    
    console.log('🔒 Configurações TLS aplicadas com pool otimizado');
  }

  console.log('🔌 Conectando ao MongoDB com pool...', {
    maxPoolSize: options.maxPoolSize,
    minPoolSize: options.minPoolSize,
    socketTimeout: options.socketTimeoutMS
  });

  const client = new MongoClient(mongoUrl, options);
  await client.connect();
  
  // ✅ Validar conectividade do pool
  await client.db(database).admin().ping();
  console.log('✅ Pool de conexões MongoDB estabelecido com sucesso!');
  
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

// POST /connect - Agora com pool de conexões
app.post('/connect', async (req, res) => {
  console.log('📥 Solicitação de conexão com pool recebida');
  
  try {
    const { connectionId, mongoUrl, database, tlsConfig } = req.body;
    
    console.log('Dados da conexão:', { connectionId, database, tlsEnabled: tlsConfig?.enabled });
    
    if (!connectionId || !mongoUrl || !database) {
      return res.status(400).json({
        success: false,
        error: 'connectionId, mongoUrl e database são obrigatórios'
      });
    }

    // ✅ Verificar se já existe pool ativo para este connectionId
    if (connectionPools.has(connectionId)) {
      const existingPool = connectionPools.get(connectionId);
      
      // Verificar se a conexão ainda está ativa
      try {
        await existingPool.db.admin().ping();
        console.log('♻️ Reutilizando pool existente:', connectionId);
        
        return res.status(200).json({
          success: true,
          message: 'Pool de conexões reutilizado com sucesso',
          connectionId,
          timestamp: new Date().toISOString()
        });
      } catch (pingError) {
        console.log('🔄 Pool existente inativo, recriando...', connectionId);
        connectionPools.delete(connectionId);
      }
    }

    // Processar certificados TLS se fornecidos
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
    
    // ✅ Criar configuração do pool
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
    
    console.log('⚙️ Criando pool com configuração:', {
      database: config.database,
      tlsEnabled: config.tlsConfig.enabled,
      hasCaFile: !!config.tlsConfig.caFile,
      hasCertFile: !!config.tlsConfig.certFile
    });
    
    // ✅ Criar novo pool de conexões
    const connectionPool = await createMongoConnectionPool(config);
    
    // ✅ Armazenar pool com metadados
    connectionPools.set(connectionId, {
      ...connectionPool,
      config,
      certFiles,
      createdAt: new Date(),
      lastUsed: new Date()
    });
    
    // Testar pool
    console.log('🏓 Testando pool com ping...');
    await connectionPool.db.admin().ping();
    console.log('🎯 Pool funcionando corretamente');
    
    res.status(200).json({
      success: true,
      message: 'Pool de conexões TLS estabelecido com sucesso',
      connectionId,
      poolInfo: {
        maxPoolSize: 10,
        minPoolSize: 2,
        socketTimeout: 45000
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Erro ao criar pool de conexões:', error);
    console.error('Stack trace:', error.stack);
    res.status(500).json({
      success: false,
      error: 'Falha ao criar pool de conexões TLS',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ✅ POST /query - Agora otimizada com pool de conexões e logs detalhados
app.post('/query', async (req, res) => {
  console.log('🔍 Query recebida via pool de conexões');
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
    
    const connectionPool = connectionPools.get(connectionId);
    if (!connectionPool) {
      console.error('❌ Pool not found:', connectionId);
      return res.status(404).json({
        success: false,
        error: 'Pool de conexões não encontrado'
      });
    }

    // ✅ Atualizar timestamp de último uso
    connectionPool.lastUsed = new Date();

    console.log('✅ Pool found, executing operation...');
    
    const coll = connectionPool.db.collection(collection);
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
      processedQuery: JSON.stringify(processedParams.query, null, 2)
    });
    
    // ✅ Executar operação com timeout adequado para cada tipo
    const operationStart = Date.now();
    
    switch (operation) {
      case 'find':
        console.log('🔍 Executando find com query:', JSON.stringify(processedParams.query));
        result = await coll.find(processedParams.query, {
          ...processedParams.options,
          maxTimeMS: 45000 // 45s timeout para finds
        }).toArray();
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
        console.log('🔍 Executando findOne com query:', JSON.stringify(processedParams.query));
        result = await coll.findOne(processedParams.query, {
          ...processedParams.options,
          maxTimeMS: 30000 // 30s timeout para findOne
        });
        console.log('📊 FindOne result:', result ? 'Found document' : 'No document found');
        break;
        
      case 'aggregate':
        console.log('📊 Executando aggregate com pipeline:', JSON.stringify(processedParams.pipeline, null, 2));
        if (!Array.isArray(processedParams.pipeline)) {
          throw new Error('Pipeline deve ser um array para operação aggregate');
        }
        result = await coll.aggregate(processedParams.pipeline, {
          ...processedParams.options,
          maxTimeMS: 90000, // 90s timeout para aggregations
          allowDiskUse: true // Permitir uso de disco para agregações pesadas
        }).toArray();
        console.log('📊 Aggregate result count:', result.length);
        break;
        
      case 'countDocuments':
        console.log('🔢 Executando countDocuments com query:', JSON.stringify(processedParams.query));
        result = await coll.countDocuments(processedParams.query, {
          ...processedParams.options,
          maxTimeMS: 60000 // 60s timeout para count
        });
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
    
    const executionTime = Date.now() - operationStart;
    console.log('✅ Query executada via pool:', {
      operation,
      executionTime: `${executionTime}ms`,
      resultSize: Array.isArray(result) ? result.length : typeof result
    });
    
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
    
    // ✅ Classificar tipo de erro
    let errorType = 'unknown';
    if (error.message.includes('timeout')) errorType = 'timeout';
    if (error.message.includes('connection')) errorType = 'connection';
    if (error.message.includes('authentication')) errorType = 'auth';
    
    res.status(500).json({
      success: false,
      error: 'Falha na execução da query via pool',
      details: error.message,
      executionTime: executionTime,
      errorType,
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
    
    const connectionPool = connectionPools.get(connectionId);
    if (!connectionPool) {
      return res.status(404).json({ success: false, error: 'Pool not found' });
    }

    // ✅ Atualizar timestamp de último uso
    connectionPool.lastUsed = new Date();

    console.log('🔍 ===== DEBUG STORES SEARCH =====');
    console.log('🆔 Franchise ID to search:', franchiseId);

    // Teste 1: Contar total de documentos
    const totalCount = await connectionPool.db.collection('stores').countDocuments({});
    console.log('📊 Total stores in collection:', totalCount);

    // Teste 2: Buscar primeiros 5 documentos para ver estrutura
    const sampleStores = await connectionPool.db.collection('stores').find({}).limit(5).toArray();
    console.log('📋 Sample stores structure:', JSON.stringify(sampleStores, null, 2));

    // Teste 3: Buscar com franchise como string
    const stringQuery = { franchise: franchiseId };
    const stringResult = await connectionPool.db.collection('stores').find(stringQuery).limit(5).toArray();
    console.log('🔍 String query result count:', stringResult.length);

    // Teste 4: Buscar com franchise como ObjectId
    const objectIdQuery = { franchise: new ObjectId(franchiseId) };
    const objectIdResult = await connectionPool.db.collection('stores').find(objectIdQuery).limit(5).toArray();
    console.log('🔍 ObjectId query result count:', objectIdResult.length);

    // Teste 5: Buscar com franchiseId como string
    const franchiseIdStringQuery = { franchiseId: franchiseId };
    const franchiseIdStringResult = await connectionPool.db.collection('stores').find(franchiseIdStringQuery).limit(5).toArray();
    console.log('🔍 FranchiseId string query result count:', franchiseIdStringResult.length);

    // Teste 6: Buscar com franchiseId como ObjectId
    const franchiseIdObjectQuery = { franchiseId: new ObjectId(franchiseId) };
    const franchiseIdObjectResult = await connectionPool.db.collection('stores').find(franchiseIdObjectQuery).limit(5).toArray();
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

// GET /collections/:connectionId - Com pool de conexões
app.get('/collections/:connectionId', async (req, res) => {
  console.log('📚 Listagem de collections via pool');
  
  try {
    const { connectionId } = req.params;
    
    const connectionPool = connectionPools.get(connectionId);
    if (!connectionPool) {
      return res.status(404).json({
        success: false,
        error: 'Pool de conexões não encontrado'
      });
    }
    
    // ✅ Atualizar timestamp de último uso
    connectionPool.lastUsed = new Date();
    
    const collections = await connectionPool.db.listCollections().toArray();
    const collectionsData = [];
    
    // ✅ Processar collections em paralelo (limitado) para melhor performance
    const batchSize = 5;
    for (let i = 0; i < collections.length; i += batchSize) {
      const batch = collections.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (collInfo) => {
        try {
          const coll = connectionPool.db.collection(collInfo.name);
          const count = await coll.countDocuments({}, { maxTimeMS: 30000 });
          
          return {
            name: collInfo.name,
            type: collInfo.type,
            documentCount: count,
            sizeBytes: 0,
            avgDocSize: 0
          };
        } catch (collError) {
          return {
            name: collInfo.name,
            type: collInfo.type,
            documentCount: 0,
            sizeBytes: 0,
            avgDocSize: 0,
            error: collError.message
          };
        }
      });
      
      const batchResults = await Promise.all(batchPromises);
      collectionsData.push(...batchResults);
    }
    
    console.log('✅ Collections listadas via pool:', collectionsData.length);
    
    res.status(200).json({
      success: true,
      collections: collectionsData,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Erro ao listar collections via pool:', error);
    res.status(500).json({
      success: false,
      error: 'Falha ao listar collections via pool',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ✅ DELETE /disconnect/:connectionId - Limpeza adequada do pool
app.delete('/disconnect/:connectionId', async (req, res) => {
  console.log('🔌 Desconectando pool de conexões');
  
  try {
    const { connectionId } = req.params;
    
    const connectionPool = connectionPools.get(connectionId);
    if (!connectionPool) {
      return res.status(404).json({
        success: false,
        error: 'Pool de conexões não encontrado'
      });
    }
    
    // ✅ Fechar pool adequadamente
    console.log('🔄 Fechando pool de conexões...', connectionId);
    await connectionPool.client.close();
    
    // Limpar certificados
    if (connectionPool.certFiles) {
      try {
        if (connectionPool.certFiles.caFile) fs.unlinkSync(connectionPool.certFiles.caFile);
        if (connectionPool.certFiles.certFile) fs.unlinkSync(connectionPool.certFiles.certFile);
      } catch (cleanupError) {
        console.log('⚠️ Erro ao limpar certificados:', cleanupError.message);
      }
    }
    
    connectionPools.delete(connectionId);
    console.log('✅ Pool de conexões desconectado:', connectionId);
    
    res.status(200).json({
      success: true,
      message: 'Pool de conexões encerrado com sucesso',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Erro ao desconectar pool:', error);
    res.status(500).json({
      success: false,
      error: 'Falha ao desconectar pool',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ✅ NOVO: Limpeza automática de pools ociosos (executada a cada 5 minutos)
setInterval(async () => {
  const now = Date.now();
  const maxIdleTime = 30 * 60 * 1000; // 30 minutos
  
  for (const [connectionId, pool] of connectionPools.entries()) {
    const idleTime = now - pool.lastUsed.getTime();
    
    if (idleTime > maxIdleTime) {
      console.log('🧹 Limpando pool ocioso:', connectionId, 'idle:', Math.floor(idleTime / 60000), 'min');
      
      try {
        await pool.client.close();
        
        // Limpar certificados
        if (pool.certFiles) {
          if (pool.certFiles.caFile) fs.unlinkSync(pool.certFiles.caFile);
          if (pool.certFiles.certFile) fs.unlinkSync(pool.certFiles.certFile);
        }
        
        connectionPools.delete(connectionId);
      } catch (error) {
        console.error('❌ Erro ao limpar pool ocioso:', error);
      }
    }
  }
}, 5 * 60 * 1000);

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

// ✅ Graceful shutdown - Fechar todos os pools
process.on('SIGINT', async () => {
  console.log('🛑 Fechando todos os pools de conexão...');
  
  for (const [connectionId, pool] of connectionPools.entries()) {
    try {
      await pool.client.close();
      console.log('✅ Pool fechado:', connectionId);
    } catch (error) {
      console.error('❌ Erro ao fechar pool:', connectionId, error);
    }
  }
  
  process.exit(0);
});

// Exportar para Vercel
module.exports = app;
