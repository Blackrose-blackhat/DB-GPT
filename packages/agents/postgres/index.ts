import { Client } from "pg";
import { Provider } from "../../types/modelType.type";
import { generatePostgresPlan } from "../llm/generatePostgresPlan";

export class PostgresAgent {
  public readonly type = 'PostgresAgent';
  client: Client;
  dbName: string;
  connected: boolean = false;
  private tableNameMap: Record<string, string> = {};

  constructor(dbUrl: string) {
    this.client = new Client({ connectionString: dbUrl });
    const match = dbUrl.match(/\/([^/?]+)(\?|$)/);
    this.dbName = match ? match[1] : "";
  }

  async connectIfNeeded() {
    if (!this.connected) {
      await this.client.connect();
      this.connected = true;
    }
  }

  async close() {
    if (this.connected) {
      await this.client.end();
      this.connected = false;
    }
  }

  async introspect(): Promise<any> {
    await this.connectIfNeeded();
    const tablesRes = await this.client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
    `);
    const schema: Record<string, any> = {};
    this.tableNameMap = {};

    for (const row of tablesRes.rows) {
      const table = row.table_name;
      this.tableNameMap[table.toLowerCase()] = table;
      const columnsRes = await this.client.query(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = $1
      `, [table]);
      schema[table] = {
        fields: columnsRes.rows.reduce((acc, col) => {
          acc[col.column_name] = { type: col.data_type };
          return acc;
        }, {} as Record<string, any>)
      };
    }
    return schema;
  }

  async generatePlan(
    userPrompt: string,
    provider: Provider = "openai",
    model: string = "gpt-3.5-turbo-instruct"
  ): Promise<any> {
    const schema = await this.introspect();
    const plan = await generatePostgresPlan({
      prompt: userPrompt,
      provider,
      model,
      schema,
      apiKey: process.env[provider === "openai" ? "OPENAI_API_KEY" : "GOOGLE_GENERATIVE_AI_API_KEY"],
    });
    return plan;
  }

  validate(plan: any): boolean {
    if (!plan.operation || !plan.table) return false;
    return true;
  }

  async execute(plan: any): Promise<any> {
    await this.connectIfNeeded();
    let res;
    let sqlQuery = "";

    const actualTableName = this.getActualTableName(plan.table);
    const quotedTableName = `"${actualTableName}"`;

    switch (plan.operation) {
      case "select": {
        const where = plan.where || "TRUE";
        const fields =
          Array.isArray(plan.fields) && plan.fields.length > 0
            ? plan.fields.join(", ")
            : "*";
        sqlQuery = `SELECT ${fields} FROM ${quotedTableName} WHERE ${where}`;
        res = await this.client.query(sqlQuery);
        break;
      }
      case "insert": {
        const fields = Object.keys(plan.values);
        const values = Object.values(plan.values);
        const placeholders = fields.map((_, i) => `$${i + 1}`).join(", ");
        sqlQuery = `INSERT INTO ${quotedTableName} (${fields.join(", ")}) VALUES (${placeholders}) RETURNING *`;
        res = await this.client.query(sqlQuery, values);
        break;
      }
      case "update": {
        const setFields = Object.keys(plan.values)
          .map((k, i) => `${k} = $${i + 1}`)
          .join(", ");
        const values = Object.values(plan.values);
        sqlQuery = `UPDATE ${quotedTableName} SET ${setFields} WHERE ${plan.where} RETURNING *`;
        res = await this.client.query(sqlQuery, values);
        break;
      }
      case "delete": {
        sqlQuery = `DELETE FROM ${quotedTableName} WHERE ${plan.where} RETURNING *`;
        res = await this.client.query(sqlQuery);
        break;
      }
      default:
        throw new Error("Unsupported operation");
    }
    return { rows: res.rows, rawQuery: sqlQuery, queryType: "sql" };
  }

  private getActualTableName(requested: string): string {
    return this.tableNameMap[requested.toLowerCase()] || requested;
  }
}