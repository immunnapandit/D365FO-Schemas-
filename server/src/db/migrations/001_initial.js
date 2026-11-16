/**
 * Initial schema. Works on Azure SQL (mssql), PostgreSQL and SQLite.
 * Dates are stored as ISO-8601 UTC strings so they sort and compare the same on every database.
 * IDs are strings (slug for forms, UUID for the rest), so no database-specific identity columns are needed.
 */

export async function up(knex) {
  await knex.schema.createTable('forms', (t) => {
    t.string('id', 64).notNullable().primary();
    t.string('name', 200).notNullable();
    t.text('description');
    t.string('icon', 16);
    t.text('definition').notNullable(); // JSON: auth, api, formSchema, uiSchema (secrets encrypted)
    t.text('allowed_roles'); // JSON array or null = every signed-in user
    t.integer('version').notNullable().defaultTo(1);
    t.boolean('is_deleted').notNullable().defaultTo(false);
    t.string('created_at', 32).notNullable();
    t.string('created_by', 200);
    t.string('updated_at', 32).notNullable();
    t.string('updated_by', 200);
  });

  await knex.schema.createTable('form_versions', (t) => {
    t.string('id', 36).notNullable().primary();
    t.string('form_id', 64).notNullable().index();
    t.integer('version').notNullable();
    t.string('change_type', 16).notNullable(); // create | update | delete | restore
    t.text('snapshot').notNullable(); // full form JSON at this version (secrets encrypted)
    t.string('changed_at', 32).notNullable();
    t.string('changed_by', 200);
  });

  await knex.schema.createTable('executions', (t) => {
    t.string('id', 36).notNullable().primary();
    t.string('form_id', 64).notNullable();
    t.string('form_name', 200);
    t.integer('form_version');
    t.string('user_id', 100);
    t.string('user_name', 200);
    t.boolean('ok').notNullable();
    t.string('stage', 16);
    t.integer('http_status');
    t.text('message');
    t.text('details'); // JSON array
    t.integer('duration_ms');
    t.text('request_json');
    t.text('response_json');
    t.string('request_id', 64);
    t.string('created_at', 32).notNullable();
    t.index(['form_id', 'created_at']);
    t.index(['user_id', 'created_at']);
    t.index(['created_at']);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('executions');
  await knex.schema.dropTableIfExists('form_versions');
  await knex.schema.dropTableIfExists('forms');
}
