import { MongoClient } from "mongodb";


let clientPromise = null;

async function getMongoClient() {
  const uri = process.env.MONGO_URI || "";
  const dbName = process.env.MONGO_DB_NAME || "";

  if (!uri || !dbName) {
    throw new Error("MongoDB is not configured. Set MONGO_URI and MONGO_DB_NAME in .env.");
  }

  if (!clientPromise) {
    const client = new MongoClient(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
    });
    clientPromise = client.connect().catch((err) => {
      clientPromise = null;
      throw err;
    });
  }

  return clientPromise;
}

export async function getReportsDb() {
  const uri = process.env.MONGO_URI || "";
  const dbName = process.env.MONGO_DB_NAME || "";
  const client = await getMongoClient();
  return client.db(dbName);
}

export async function pingMongo() {
  const client = await getMongoClient();
  const dbName = process.env.MONGO_DB_NAME || "";
  await client.db(dbName).command({ ping: 1 });
  return true;
}

