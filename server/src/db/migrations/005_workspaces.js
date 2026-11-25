/**
 * Workspaces: each user keeps their own modules, forms and history apart (e.g. one per client project).
 * Existing rows get no workspace here; the first admin to sign in takes them into their first workspace.
 */

export async function up(knex) {
  await knex.schema.createTable('workspaces', (t) => {
    t.string('id', 36).notNullable().primary();
    t.string('name', 60).notNullable();
    t.string('owner_id', 100).notNullable().index();
    t.string('owner_name', 200);
    t.boolean('is_deleted').notNullable().defaultTo(false);
    t.string('created_at', 32).notNullable();
    t.string('updated_at', 32).notNullable();
  });
  for (const table of ['forms', 'modules', 'executions']) {
    await knex.schema.alterTable(table, (t) => {
      t.string('workspace_id', 36).index();
    });
  }
}

export async function down(knex) {
  for (const table of ['forms', 'modules', 'executions']) {
    await knex.schema.alterTable(table, (t) => {
      t.dropIndex(['workspace_id']);
      t.dropColumn('workspace_id');
    });
  }
  await knex.schema.dropTable('workspaces');
}
