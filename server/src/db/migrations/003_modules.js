/** Modules: the sign-in and variables shared by all forms listed under a module (matched by forms.category). */

export async function up(knex) {
  await knex.schema.createTable('modules', (t) => {
    t.string('id', 64).notNullable().primary();
    t.string('name', 60).notNullable();
    t.text('description');
    t.text('definition').notNullable(); // JSON: auth, variables (secrets encrypted)
    t.integer('version').notNullable().defaultTo(1);
    t.boolean('is_deleted').notNullable().defaultTo(false);
    t.string('created_at', 32).notNullable();
    t.string('created_by', 200);
    t.string('updated_at', 32).notNullable();
    t.string('updated_by', 200);
  });
}

export async function down(knex) {
  await knex.schema.dropTable('modules');
}
