$(function() {

	$.getJSON("./deck.json", function(deck) {
		
		// generate a question
		// -- sample three cards. The first is the target, the other two provide false answers
		sample = _.sampleSize(deck.cards, 3)
		corr = _.sample([0, 1, 2])
					
		$("article").loadTemplate('templates/mc.html', {
			question: sample[corr].f,
			answer0: sample[0].b,
			answer1: sample[1].b,
			answer2: sample[2].b
		});
	})

;});

