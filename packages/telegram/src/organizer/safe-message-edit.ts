import { GrammyError } from 'grammy';

export const safelyEditTelegramMessage = async (
  edit: () => Promise<unknown>,
): Promise<void> => {
  try {
    await edit();
  } catch (error) {
    if (
      error instanceof GrammyError &&
      error.error_code === 400 &&
      /^Bad Request: message is not modified(?::|$)/i.test(error.description)
    ) {
      return;
    }
    throw error;
  }
};
