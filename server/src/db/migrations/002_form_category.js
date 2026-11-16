/** Adds the module (category) a form is listed under in the navigation. */

export async function up(knex) {
  await knex.schema.alterTable('forms', (t) => {
    t.string('category', 60);
  });
}

export async function down(knex) {
  await knex.schema.alterTable('forms', (t) => {
    t.dropColumn('category');
  });
}
