$(function() {

	$.getJSON("./deck.json", startTraining)


;});

function startTraining(deck)
{

    session = {
        templates:
        {
            mc: $.templates("#mc")
        },
        sounds: {
            correct: new Audio('/sounds/correct.mp3'),
            incorrect: new Audio('/sounds/incorrect.wav')
        }
    }

    generate(deck, session);

}

function generate(deck, session){

            // generate a question
            // -- sample three cards. The first is the target, the other two provide false answers
            sample = _.sampleSize(deck.cards, 3);
            corr = _.sample([0, 1, 2]);

            $("article").html(
                session.templates.mc.render({
                    question: sample[corr].f,
                    answer0: sample[0].b,
                    answer1: sample[1].b,
                    answer2: sample[2].b
                })
            )

            $("article ul#answers li button").on(
                'click',
                {
                    correct: corr,
                    session: session
                },
                processAnswer
            )
}

function processAnswer(e)
{
     session = e.data.session

     answered = $(e.target).data('answer')
     correct = e.data.correct

     if(answered == correct)
     {
        $('article').append('Correct!');
        session.sounds.correct.play()
     } else
     {
        $('article').append('Incorrect!');
        session.sounds.incorrect.play()
     }

}